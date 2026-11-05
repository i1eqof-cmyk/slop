import { defineConfig } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function localBenchmarkReport() {
  return {
    name: 'local-benchmark-report',
    configureServer(server) {
      server.middlewares.use('/__benchmark-report', (request, response, next) => {
        if (request.method !== 'POST') return next();

        const chunks = [];
        let receivedBytes = 0;
        request.on('data', (chunk) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > 2 * 1024 * 1024) {
            response.statusCode = 413;
            response.end(JSON.stringify({ error: 'Benchmark report is too large.' }));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on('end', async () => {
          if (response.writableEnded) return;
          try {
            const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (report.reportTitle !== 'Global EPT browser benchmark') {
              response.statusCode = 400;
              response.end(JSON.stringify({ error: 'Unexpected benchmark report.' }));
              return;
            }
            const outputDirectory = resolve(projectRoot, 'results');
            await mkdir(outputDirectory, { recursive: true });
            const filename = `browser-ept-benchmark-${Date.now()}.json`;
            await writeFile(
              resolve(outputDirectory, filename),
              `${JSON.stringify(report, null, 2)}\n`,
              { flag: 'wx' },
            );
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ saved: true, path: `results/${filename}` }));
          } catch (error) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: error.message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [localBenchmarkReport()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        benchmark: resolve(projectRoot, 'advanced-benchmark.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@firebase/')) return 'firebase';
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
