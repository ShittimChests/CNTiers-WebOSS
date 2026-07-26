import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(repoRoot, 'app');

/**
 * 客户端资产构建。产物落在 dist/public/，由 Express 以静态目录挂载：
 *   dist/public/assets/*             —— 带 hash 的 JS/CSS，immutable 缓存
 *   dist/public/.vite/manifest.json  —— 服务端 assets.ts 据此拼 <script>/<link>
 *   dist/public/<其余>               —— app/static/ 原样复制（favicon、sprite、字体）
 *
 * 注意不要输出到仓库根的 public/——那是现役旧站的静态目录，M8 切换后才会移除。
 */
export default defineConfig({
  root,
  publicDir: resolve(root, 'static'),
  build: {
    outDir: resolve(repoRoot, 'dist/public'),
    emptyOutDir: true,
    manifest: true,
    target: 'es2022',
    cssMinify: true,
    rollupOptions: {
      input: {
        app: resolve(root, 'client/app.ts'),
        styles: resolve(root, 'styles/app.css'),
        // 按页入口：只有需要的页面才加载，互不拖累
        board: resolve(root, 'client/pages/board.ts'),
        admin: resolve(root, 'client/pages/admin.ts')
      },
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]'
      }
    }
  }
});
