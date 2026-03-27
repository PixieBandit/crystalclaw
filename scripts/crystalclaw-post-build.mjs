/**
 * CrystalClaw post-build: deploy Crystal Chat into control-ui.
 * Single file deploy as crystal-chat/index.html (subfolder so gateway
 * serves it via serveResolvedIndexHtml with proper CSP inline-script hashes).
 */
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "crystalclaw-assets", "control-ui", "crystal-chat", "index.html");
const destDir = join(root, "dist", "control-ui", "crystal-chat");
const dest = join(destDir, "index.html");

if (!existsSync(src)) {
  console.log("[crystalclaw] No crystal-chat/index.html in crystalclaw-assets, skipping.");
  process.exit(0);
}

if (!existsSync(join(root, "dist", "control-ui"))) {
  console.log("[crystalclaw] No dist/control-ui found, skipping post-build.");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[crystalclaw] Deployed crystal-chat/index.html to dist/control-ui/crystal-chat/");
console.log("[crystalclaw] Access at /crystal-chat/");
console.log("[crystalclaw] Post-build complete.");
