// Самопроверка логики графа: Node 24 исполняет TS со срезанием типов,
// нужно лишь дописать расширение в относительном импорте.
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Node исполняет TS со срезанием типов, но требует расширения в относительных импортах.
const copies = ['graph', 'markdown'].map((name) => {
  const to = new URL(`../src/__check_${name}.ts`, import.meta.url)
  const code = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
    .replace(/'\.\/types'/g, "'./types.ts'")
    .replace(/'\.\/graph'/g, "'./__check_graph.ts'")
  writeFileSync(to, code)
  return to
})

let m, md
try {
  m = await import(pathToFileURL(copies[0].pathname.slice(1)).href)
  md = await import(pathToFileURL(copies[1].pathname.slice(1)).href)
} finally {
  for (const c of copies) rmSync(c)
}

const { wouldCreateCycle, ancestorsOf, inheritedContext, inheritedTerms, citationsOf, synopsesOf, acceptedFindingsOf, citationList, layered } = m

let failed = 0
const ok = (name, cond) => {
  if (!cond) failed++
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name)
}

const E = (s, t, kind = 'context', order) => ({ id: `${s}->${t}`, source: s, target: t, data: { kind, order } })
const F = (status, excerpt) => ({
  id: 'f-' + status, sourceTitle: 'Книга ' + status, sourceLang: 'en',
  locator: { kind: 'page', page: 1 }, excerpt, why: '', status,
})
const query = (id, findings = []) => ({
  id, type: 'query', position: { x: 0, y: 0 },
  data: { title: id.toUpperCase(), collapsed: false, notes: [{ id: id + '-n', question: 'q', state: 'fresh', findings }] },
})
const synopsis = (id) => ({ id, type: 'synopsis', position: { x: 0, y: 0 }, data: { title: id, text: '', collapsed: false } })

// ── стрелки контекста ────────────────────────────
const edges = [E('a', 'b'), E('b', 'c', 'narrow')]

ok('прямой цикл a→a отклоняется', wouldCreateCycle(edges, 'a', 'a') === true)
ok('обратная связь c→a создаёт цикл', wouldCreateCycle(edges, 'c', 'a') === true)
ok('ветка a→c цикла не создаёт', wouldCreateCycle(edges, 'a', 'c') === false)
ok('предки c = [b, a]', JSON.stringify(ancestorsOf(edges, 'c')) === '["b","a"]')

const nodes = [
  query('a', [
    F('accepted', 'про **happens-before** тут'),
    F('rejected', 'мимо **ignored**'),
    F('pinned', 'и **synchronizes-with**'),
  ]),
  query('b'),
  query('c'),
]

const inh = inheritedContext(nodes, edges, 'c')
ok('наследуются только принятые и закреплённые (2 из 3)', inh.length === 2)
ok('отклонённая находка не наследуется', !inh.some((i) => i.finding.status === 'rejected'))

const terms = inheritedTerms(inh)
ok('термины извлечены: ' + JSON.stringify(terms), terms.length === 2 && terms.includes('happens-before'))
ok('у дальнего предка тип связи — контекст', inh.every((i) => i.kind === 'context'))
ok('прямая стрелка сохраняет тип «сужение»', inheritedContext(nodes, [E('a', 'c', 'narrow')], 'c').every((i) => i.kind === 'narrow'))

// ── блок-запрос он же блок-ссылка ───────────────
ok('принятые выписки запроса отобраны (2 из 3)', acceptedFindingsOf(nodes[0]).length === 2)
ok('у конспекта своих выписок нет', acceptedFindingsOf(synopsis('s0')).length === 0)

// ── подшивка в конспект ─────────────────────────
const citeNodes = [synopsis('s1'), synopsis('s2'), query('r1', [F('accepted', 'раз')]), query('r2', [F('pinned', 'два')])]
const citeEdges = [E('r2', 's1', 'cite', 1), E('r1', 's1', 'cite', 0)]
const cites = citationsOf(citeNodes, citeEdges, 's1')
ok('запросы конспекта отданы в порядке order', cites.map((c) => c.query.id).join(',') === 'r1,r2')
ok('у другого конспекта подшивок нет', citationsOf(citeNodes, citeEdges, 's2').length === 0)
ok('запрос знает свои конспекты', JSON.stringify(synopsesOf(citeEdges, 'r1')) === '["s1"]')
ok('один запрос можно подшить к двум конспектам', synopsesOf([...citeEdges, E('r1', 's2', 'cite', 0)], 'r1').length === 2)

// Подшивка — не связь контекста: в DAG запросов она не участвует.
ok('подшивка не считается стрелкой контекста', ancestorsOf(citeEdges, 's1').length === 0)
ok('две ссылки в один конспект — не цикл', wouldCreateCycle(citeEdges, 'r1', 's1') === false)
ok('подшивка не даёт наследования контекста', inheritedContext(citeNodes, citeEdges, 's1').length === 0)

// ── сквозная нумерация цитат ────────────────────
const numNodes = [
  synopsis('s1'),
  query('q1', [F('accepted', 'first'), { ...F('rejected', 'skip'), id: 'f-skip' }]),
  query('q2', [{ ...F('pinned', 'second'), id: 'f-two' }, { ...F('accepted', 'third'), id: 'f-three' }]),
]
const numEdges = [E('q1', 's1', 'cite', 0), E('q2', 's1', 'cite', 1)]
const list = citationList(numNodes, numEdges, 's1')
ok('нумерация сквозная по порядку подшивок: 1,2,3', list.map((c) => c.n).join(',') === '1,2,3')
ok('отклонённая выписка номера не получает', !list.some((c) => c.finding.status === 'rejected'))
ok('первым идёт запрос с order 0', list[0].queryId === 'q1')

const swapped = citationList(numNodes, [E('q1', 's1', 'cite', 1), E('q2', 's1', 'cite', 0)], 's1')
ok('смена порядка подшивок перенумеровывает цитаты', swapped[0].queryId === 'q2')
ok('у чужого конспекта цитат нет', citationList(numNodes, numEdges, 's2').length === 0)

// ── выгрузка в Markdown ─────────────────────────
const mdText = md.toMarkdown(numNodes, numEdges)
ok('заголовок конспекта на месте', mdText.startsWith('# s1'))
ok('есть раздел источников', mdText.includes('## Sources'))
ok('цитаты пронумерованы 1..3', /1\. \*\*/.test(mdText) && /3\. \*\*/.test(mdText))
ok('локатор выведен человекочитаемо', mdText.includes('p. 1'))
ok('отклонённая выписка в выгрузку не попала', !mdText.includes('skip'))
ok('выписка оформлена цитатой', mdText.includes('> first'))
const mdLoose = md.toMarkdown([...numNodes, query('lonely', [F('accepted', 'orphan')])], numEdges)
ok('неподшитый запрос попадает в приложение', mdLoose.includes('## Unfiled references') && mdLoose.includes('LONELY'))

// ── раскладка ───────────────────────────────────
ok('ярусы по глубине: 0 / 440 / 880', layered(nodes, edges).map((n) => n.position.x).join(',') === '0,440,880')
const laidWithSynopsis = layered([...nodes, synopsis('s9')], edges)
ok('конспект уходит в колонку правее всех запросов', laidWithSynopsis.at(-1).position.x === 1320)
ok('раскладка не зависает на цикле', layered([query('x'), query('y')], [E('x', 'y'), E('y', 'x')]).length === 2)
ok('подшивка не сдвигает ярусы запросов', layered(citeNodes, citeEdges).filter((n) => n.type === 'query').every((n) => n.position.x === 0))

console.log(failed ? `\n${failed} проверок упало` : '\nвсе проверки прошли')
process.exit(failed ? 1 : 0)
