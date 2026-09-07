import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['src/**/*.integration.ts'],exclude:process.env.V3_LOCAL_APP?[]:['**/workbench.integration.ts'],testTimeout:20000,hookTimeout:20000,fileParallelism:false}});
