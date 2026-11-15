import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Явно IPv4: по умолчанию Vite слушает только ::1, а бэкенд — 127.0.0.1,
    // и один и тот же адрес вёл то к интерфейсу, то в пустоту.
    host: '127.0.0.1',
    port: 5174,
  },
})
