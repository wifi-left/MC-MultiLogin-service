/*
 * 管理面板的 3D 皮肤/披风预览：three.js + skinview3d（与 LittleSkin / Blessing Skin 同一套技术栈）。
 *
 * 本文件是**源码**，浏览器不直接加载它：`node vendor/build.mjs` 把 skinview3d 官方自包含 UMD 包
 * （bundles/skinview3d.bundle.js，已内置 three.js，全局名 `skinview3d`）与本文件拼接成
 * web/public/vendor/mcviewer.js 后才由面板用 <script> 引入。所以这里只使用全局
 * window.skinview3d.*，不 import 任何模块，运行时不依赖 CDN、也不需要 npm 安装。
 *
 * 对外接口（window.MCViewer）以**句柄**为单位，面板持有句柄即可控制与释放：
 *   handle = MCViewer.create(canvas, { kind, url, model, animation, spin, locked, width, height })
 *   handle.ready          加载贴图的 Promise（失败时 reject，原因同时写入 handle.error）
 *   handle.setAnimation() 切换动作      handle.setSpin()   自动旋转开关
 *   handle.setLocked()    锁定正面视角  handle.resetView() 复位视角
 *   handle.dispose()      释放该预览（含 WebGL 上下文）——面板重建 DOM 前必须调用
 * 用句柄而不是全局下标，是因为面板会整块重建查询结果：下标数组一旦与 DOM 失去对应关系，
 * 就会出现「按钮控制到别的预览」「旧预览的渲染循环与上下文永远不释放」这两类问题。
 */
(function () {
    "use strict";

    const sv = window.skinview3d;
    if (!sv || !sv.SkinViewer) {
        window.MCViewer = {
            available: false,
            animations: [],
            create: function () {
                throw new Error("skinview3d 未加载：vendor/mcviewer.js 不完整或加载失败");
            },
            disposeAll: function () { },
            liveCount: function () { return 0; },
            errors: ["skinview3d 未加载（vendor/mcviewer.js 不完整或加载失败）"],
            lastError: "skinview3d 未加载"
        };
        return;
    }

    // 动作名 → skinview3d 动画类；面板的动作下拉直接用 MCViewer.animations 渲染，避免两处各写一份清单
    const ANIMATIONS = {
        idle: sv.IdleAnimation,
        walk: sv.WalkingAnimation,
        run: sv.RunningAnimation,
        swim: sv.SwimAnimation,
        fly: sv.FlyingAnimation,
        crouch: sv.CrouchAnimation,
        hit: sv.HitAnimation,
        none: null
    };

    // 取景参数。skinview3d 的 zoom 是唯一的取景旋钮（由 fov + zoom 反算相机距离），
    // 不要手写相机位置：PlayerObject 已把模型摆在原点（脚底 -16 ~ 头顶 +16，共 32 单位，
    // 中心正好是 OrbitControls 默认的 target），所以皮肤按默认视角即可，只有披风需要拉近
    // ——披风挂在背后 y≈±8，若沿用整具模型的取景在框里会显得太小。
    const SKIN_ZOOM = 0.9;
    const CAPE_ZOOM = 2.4;

    const viewers = [];
    const errors = [];

    // 贴图加载失败时 skinview-utils 抛的是 Image 的 error 事件（没有 message），
    // 直接 String(e) 只会得到 "[object Event]"，这里换成能指导排查的说法
    function errorText(e) {
        if (!e) return "未知错误";
        if (typeof e === "string") return e;
        if (e.message) return String(e.message);
        if (e.type === "error" || (typeof Event === "function" && e instanceof Event)) {
            return "贴图加载失败（404、网络错误或该域名不允许跨站读取）";
        }
        return String(e);
    }

    function recordError(handle, e) {
        const msg = errorText(e);
        errors.push(msg);
        if (errors.length > 20) errors.shift();
        if (handle) handle.error = msg;
        window.MCViewer.lastError = msg;
        return msg;
    }

    function newAnimation(name) {
        const Ctor = ANIMATIONS[name];
        return Ctor ? new Ctor() : null;
    }

    // 服务端给的是 classic | slim（Mojang 档案里的模型名），skinview3d 的取值是 default | slim | auto-detect
    function mapModel(model) {
        const m = String(model || "").toLowerCase();
        if (m === "slim") return "slim";
        if (m === "classic" || m === "default") return "default";
        return "auto-detect";
    }

    // skinview3d 的 setSize 会同时改画布尺寸与相机 aspect，0/NaN 会把投影矩阵算坏；
    // 隐藏容器（隐藏的标签页、display:none）里量不到尺寸，此时保留上一次的可用尺寸
    function applySize(handle) {
        if (handle.disposed || !handle.viewer) return;
        const canvas = handle.canvas;
        let width = Math.round(canvas.clientWidth || 0);
        let height = Math.round(canvas.clientHeight || 0);
        if (width < 1 || height < 1) {
            width = handle.width;
            height = handle.height;
        } else {
            handle.width = width;
            handle.height = height;
        }
        if (width === handle.appliedWidth && height === handle.appliedHeight) return;
        try {
            handle.viewer.setSize(width, height);
            handle.appliedWidth = width;
            handle.appliedHeight = height;
        } catch (e) {
            recordError(handle, e);
        }
    }

    function observeSize(handle) {
        // 插入 DOM 后再量一次（创建时容器可能还没有布局完成）
        setTimeout(function () { applySize(handle); }, 0);
        if (typeof ResizeObserver !== "function") return;
        handle.resizeObserver = new ResizeObserver(function () { applySize(handle); });
        handle.resizeObserver.observe(handle.canvas);
    }

    // 隐藏标签页里的预览、滚出视口的预览都没必要占着 GPU：暂停渲染循环（renderPaused 会停 rAF，
    // 恢复时继续；库内部会一起停时钟，不会在恢复瞬间让动画跳一大步）
    function applyPaused(handle) {
        if (handle.disposed || !handle.viewer) return;
        try {
            handle.viewer.renderPaused = !handle.visible || document.hidden;
        } catch (e) {
            recordError(handle, e);
        }
    }

    function observeVisibility(handle) {
        handle.visible = true;
        if (typeof IntersectionObserver === "function") {
            handle.intersectionObserver = new IntersectionObserver(function (entries) {
                let visible = false;
                entries.forEach(function (entry) { if (entry.isIntersecting) visible = true; });
                handle.visible = visible;
                applyPaused(handle);
            });
            handle.intersectionObserver.observe(handle.canvas);
        }
    }

    // 主动补一帧。skinview3d 的画面完全由 rAF 循环驱动，而浏览器会暂停后台标签页/隐藏容器里的
    // rAF：只等循环的话，隐藏标签页中创建的预览会一直空着（例如从"曾用名追踪"页重建远程信息面板）。
    // 贴图就绪后自己渲染一帧，画布无论是否可见都立刻有正确内容
    function renderOnce(handle) {
        if (handle.disposed || !handle.viewer) return;
        try {
            handle.viewer.render();
        } catch (e) {
            recordError(handle, e);
        }
    }

    function loadTexture(handle, url, model) {
        if (!url) return Promise.resolve();
        const viewer = handle.viewer;
        let load;
        // 披风预览不加载皮肤：skinview3d 默认皮肤不可见，所以画面里只有披风
        if (handle.kind === "cape") {
            load = viewer.loadCape(url);
        } else {
            load = viewer.loadSkin(url, { model: mapModel(model) });
        }
        return Promise.resolve(load).catch(function (e) {
            recordError(handle, e);
            throw new Error(handle.error);
        });
    }

    function resetView(handle) {
        const viewer = handle.viewer;
        if (!viewer) return;
        try {
            viewer.controls.target.set(0, 0, 0);
            viewer.resetCameraPose();
            viewer.controls.update();
            // 立刻出图：渲染循环被浏览器暂停时（后台标签页、隐藏容器）也能看到复位结果
            renderOnce(handle);
        } catch (e) {
            recordError(handle, e);
        }
        return true;
    }

    function create(canvas, opts) {
        const options = opts || {};
        const kind = options.kind === "cape" ? "cape" : "skin";
        const handle = {
            canvas: canvas,
            kind: kind,
            viewer: null,
            ready: null,
            error: null,
            disposed: false,
            locked: options.locked === true,
            spin: options.spin !== false,
            animation: options.animation || "idle",
            width: Math.round(options.width || canvas.clientWidth || 0) || 220,
            height: Math.round(options.height || canvas.clientHeight || 0) || 330,
            appliedWidth: 0,
            appliedHeight: 0,
            visible: true
        };

        try {
            // 不需要自己 new WebGLRenderer（SkinViewerOptions 也没有这个选项）：画布上的 WebGL
            // 上下文由 SkinViewer 内部创建并复用，three 固定 alpha:true、skinview3d 默认
            // setClearColor(0,0)，所以画布是透明的，面板 .mc-scene 的底色能透出来
            handle.viewer = new sv.SkinViewer({
                canvas: canvas,
                width: handle.width,
                height: handle.height,
                preserveDrawingBuffer: true,
                animation: newAnimation(handle.animation),
                zoom: kind === "cape" ? CAPE_ZOOM : SKIN_ZOOM
            });
        } catch (e) {
            recordError(handle, e);
            viewers.push(handle);
            handle.ready = Promise.reject(new Error(handle.error));
            return handle;
        }

        const viewer = handle.viewer;
        viewer.autoRotateSpeed = 0.7;
        viewer.controls.enableZoom = true;
        viewer.controls.enableRotate = !handle.locked;
        viewer.autoRotate = handle.spin && !handle.locked;
        try {
            viewer.zoom = kind === "cape" ? CAPE_ZOOM : SKIN_ZOOM;
        } catch (e) {
            recordError(handle, e);
        }

        handle.setAnimation = function (name) {
            handle.animation = name;
            if (handle.disposed || !handle.viewer) return;
            try {
                handle.viewer.animation = newAnimation(name);
                // 立刻出图：切换动作后马上看到新姿态，不必等渲染循环（后台标签页里 rAF 会被暂停）
                renderOnce(handle);
            } catch (e) {
                recordError(handle, e);
            }
        };
        handle.setSpin = function (on) {
            handle.spin = !!on;
            if (handle.viewer) handle.viewer.autoRotate = handle.spin && !handle.locked;
        };
        handle.setLocked = function (locked) {
            handle.locked = !!locked;
            if (!handle.viewer) return;
            handle.viewer.controls.enableRotate = !handle.locked;
            handle.viewer.autoRotate = handle.spin && !handle.locked;
            if (handle.locked) resetView(handle);
        };
        handle.resetView = function () { return resetView(handle); };
        handle.dispose = function () {
            if (handle.disposed) return;
            handle.disposed = true;
            if (handle.resizeObserver) {
                handle.resizeObserver.disconnect();
                handle.resizeObserver = null;
            }
            if (handle.intersectionObserver) {
                handle.intersectionObserver.disconnect();
                handle.intersectionObserver = null;
            }
            const i = viewers.indexOf(handle);
            if (i >= 0) viewers.splice(i, 1);
            const viewer = handle.viewer;
            handle.viewer = null;
            if (!viewer) return;
            try {
                viewer.dispose();
                // 立即归还 WebGL 上下文：面板每查一个玩家就会重建预览，不主动释放的话很快会撞上
                // 浏览器「同时活动的上下文数量」上限（约 16 个），最早的预览就会莫名黑屏
                if (viewer.renderer && viewer.renderer.forceContextLoss) viewer.renderer.forceContextLoss();
            } catch (e) {
                recordError(handle, e);
            }
        };

        viewers.push(handle);
        applySize(handle);
        observeSize(handle);
        observeVisibility(handle);
        applyPaused(handle);
        handle.ready = loadTexture(handle, options.url, options.model).then(function () {
            renderOnce(handle);
        });
        return handle;
    }

    window.MCViewer = {
        available: true,
        // 面板动作下拉的取值来源（顺序即显示顺序，文案在面板里给）
        animations: ["idle", "walk", "run", "swim", "fly", "crouch", "hit", "none"],
        create: create,
        disposeAll: function () {
            viewers.slice().forEach(function (handle) { handle.dispose(); });
        },
        // 诊断：当前存活的预览数量（面板重建前后可对比，确认旧预览确实被释放）
        liveCount: function () { return viewers.length; },
        // 诊断：逐个预览的状态快照。排查「预览不出来 / 不动 / 黑屏」时可直接在控制台执行
        // MCViewer.diagnose() 看：paused（渲染循环是否被暂停）、contextLost（WebGL 上下文是否丢失）、
        // error（贴图加载失败原因）、animation/locked/spin（面板按钮是否真的作用到了预览上）
        diagnose: function () {
            return viewers.map(function (handle) {
                const viewer = handle.viewer;
                let contextLost = null;
                try {
                    const gl = viewer && viewer.renderer && viewer.renderer.getContext
                        ? viewer.renderer.getContext()
                        : null;
                    contextLost = gl && gl.isContextLost ? gl.isContextLost() : null;
                } catch (e) {
                    contextLost = null;
                }
                return {
                    kind: handle.kind,
                    animation: handle.animation,
                    locked: handle.locked,
                    spin: handle.spin,
                    paused: viewer ? viewer.renderPaused : null,
                    visible: handle.visible,
                    size: handle.appliedWidth + "x" + handle.appliedHeight,
                    contextLost: contextLost,
                    error: handle.error
                };
            });
        },
        errors: errors,
        lastError: null
    };

    document.addEventListener("visibilitychange", function () {
        viewers.slice().forEach(applyPaused);
    });
})();
