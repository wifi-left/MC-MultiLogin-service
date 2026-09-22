/*
 * 生成管理面板的 3D 预览脚本 web/public/vendor/mcviewer.js。
 *
 * 面板用的是 skinview3d（three.js powered Minecraft skin viewer，与 LittleSkin / Blessing Skin
 * 同一套技术栈）。它官方发布的 bundles/skinview3d.bundle.js 是**自包含 UMD 包**（已内置 three.js，
 * 全局名 `skinview3d`），所以这里不需要 npm 安装任何依赖，也不需要打包器：
 *
 *   产物 = 官方 UMD 包（校验 SHA-256） + src/vendor/mcviewer.js（本项目的面板适配层）
 *
 * 用法：
 *   node vendor/build.mjs              # 构建（本地没有 vendor/skinview3d.bundle.js 时从 jsDelivr 下载）
 *   node vendor/build.mjs --print-hash # 打印官方包的 sha256，用于升级版本时更新下面的常量
 *
 * 离线/内网构建：把官方包放到 vendor/skinview3d.bundle.js，脚本会直接使用它，不再联网。
 * 升级 skinview3d：改 PINNED_VERSION → 跑 --print-hash 更新 PINNED_SHA256 → 重新构建并验证面板。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PINNED_VERSION = "3.4.2";
const PINNED_SHA256 = "e2a60ce607f2169e24b18bfd6e5214113b66f30d92e23f9a021ebbd4b21c08d3";
const CDN_URL = `https://cdn.jsdelivr.net/npm/skinview3d@${PINNED_VERSION}/bundles/skinview3d.bundle.js`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor");
const cachedBundle = path.join(vendorDir, "skinview3d.bundle.js");
const wrapperPath = path.join(root, "src", "vendor", "mcviewer.js");
const outPath = path.join(root, "web", "public", "vendor", "mcviewer.js");

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readUpstreamBundle() {
    if (fs.existsSync(cachedBundle)) {
        console.log(`[build] 使用本地缓存 vendor/skinview3d.bundle.js`);
        return fs.readFileSync(cachedBundle);
    }
    if (typeof fetch !== "function") {
        throw new Error("当前 Node 不支持 fetch（需要 Node 18+）。请手动下载官方包后放到 vendor/skinview3d.bundle.js：\n  " + CDN_URL);
    }
    console.log(`[build] 下载 skinview3d@${PINNED_VERSION} 官方 UMD 包：${CDN_URL}`);
    const res = await fetch(CDN_URL, { redirect: "follow" });
    if (!res.ok) {
        throw new Error(`下载失败（HTTP ${res.status}）。可手动下载后放到 vendor/skinview3d.bundle.js：\n  ${CDN_URL}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // 缓存下来，之后离线也能重新构建
    fs.writeFileSync(cachedBundle, buffer);
    console.log(`[build] 已缓存到 vendor/skinview3d.bundle.js`);
    return buffer;
}

// 不发布 sourcemap，末尾的 sourceMappingURL 注释会指向一个不存在的文件（浏览器只在调试时读它）
function stripSourceMappingUrl(code) {
    return code.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "");
}

async function main() {
    if (!fs.existsSync(wrapperPath)) {
        throw new Error(`找不到适配层源码：${wrapperPath}`);
    }

    const upstream = await readUpstreamBundle();
    const upstreamHash = sha256(upstream);

    if (process.argv.includes("--print-hash")) {
        console.log(`[build] 本地包 sha256: ${upstreamHash}`);
        if (upstreamHash !== PINNED_SHA256) {
            console.log(`[build] 与脚本里的 PINNED_SHA256 不一致（当前：${PINNED_SHA256}）`);
            console.log(`[build] 确认这是要做版本升级后，把 PINNED_VERSION 与 PINNED_SHA256 同步改成上面这两个值`);
        }
        return;
    }

    // 校验哈希：官方包是直接从 CDN 下载后拼接进面板的脚本，内容不能被替换（供应链/镜像劫持）
    if (upstreamHash !== PINNED_SHA256) {
        throw new Error(
            `skinview3d 包校验失败，已中止构建。\n` +
            `  期望 sha256: ${PINNED_SHA256}（skinview3d@${PINNED_VERSION}）\n` +
            `  实际 sha256: ${upstreamHash}\n` +
            `如果这是你有意升级版本，请依次更新本脚本的 PINNED_VERSION 与 PINNED_SHA256；\n` +
            `否则请删除 vendor/skinview3d.bundle.js 后重跑，或检查下载源是否被篡改。`
        );
    }

    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    const header =
        `/*\n` +
        ` * 自动生成，请勿直接编辑：node vendor/build.mjs\n` +
        ` *   - skinview3d @${PINNED_VERSION} 官方 UMD 包（MIT，https://github.com/bs-community/skinview3d），已内置 three.js（MIT）\n` +
        ` *   - 本项目适配层：src/vendor/mcviewer.js\n` +
        ` * 内容校验：skinview3d 包 sha256 ${PINNED_SHA256}\n` +
        ` */\n`;

    const output = header + stripSourceMappingUrl(upstream.toString("utf8")) + "\n" + wrapper;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);

    const bytes = Buffer.byteLength(output);
    console.log(`[build] 输出 ${path.relative(root, outPath)}：${bytes} 字节（${(bytes / 1024).toFixed(1)} KB）`);
    console.log(`[build] 产物 sha256 ${sha256(Buffer.from(output))}`);
}

main().catch(err => {
    console.error(`[build] ${err && err.message ? err.message : err}`);
    process.exit(1);
});
