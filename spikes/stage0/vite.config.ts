import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({root:'spikes/stage0/ui',plugins:[react()],build:{outDir:'../../../dist/stage0',emptyOutDir:true}});
