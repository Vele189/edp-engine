import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { edpApi } from './server/apiPlugin';

export default defineConfig({
  plugins: [react(), edpApi()],
});
