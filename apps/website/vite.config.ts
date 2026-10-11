import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [marmeon(), react()] });
