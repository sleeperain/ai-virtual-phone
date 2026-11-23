"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadReadingCustomCss, saveReadingCustomCss } from "@/lib/reading-custom-css";
import { DAY_SET_ID, nightSlotKeys, useActiveLookSet, useNightRevision, useNightText } from "@/lib/night-mode";
import { loadReadingLook, loadReadingLookBackground, saveReadingLook } from "@/lib/reading-look";
import { hydrateReadingStorage } from "@/lib/reading-storage";
import { ReadingShelf } from "./reading-shelf";
import { ReadingViewer } from "./reading-viewer";
import type { Book } from "@/lib/reading-types";
import {
    DEFAULT_READING_APPEARANCE,
    loadReadingAnnotationFont,
    loadReadingAppearance,
    loadReadingBackground,
    loadReadingCustomFont,
    loadReadingUserAnnotationFont,
    readingBackgroundOverlay,
    readingMarkColor,
    READING_ANNOTATION_STYLE_DEFAULTS,
    resolveReadingAnnotationFontFamily,
    resolveReadingFontFamily,
    saveReadingAnnotationFont,
    saveReadingAppearance,
    saveReadingBackground,
    saveReadingCustomFont,
    saveReadingUserAnnotationFont,
    type ReadingAppearance,
} from "@/lib/reading-appearance";
import type { ReadingAppearanceSaveOptions } from "./reading-appearance-dialog";

type Props = { onClose: () => void };

type AnnotationCardStyle = { fontSize: number; lineHeight: number; textColor: string; cardColor: string };

/** 一档标记（我的 / TA 的）的高亮底色和划线颜色。
 *  高亮留 0.72、划线留 0.85 的透明度，底下的背景图还透得出来。 */
function markColorCss(suffix: string, highlight?: string, underline?: string, isChar = false): string {
    const mark = `.reading-app-surface .reading-mark${suffix}`;
    const highlightColor = highlight
        || (isChar ? READING_ANNOTATION_STYLE_DEFAULTS.charHighlightColor : READING_ANNOTATION_STYLE_DEFAULTS.highlightColor);
    const underlineColor = underline
        || (isChar ? READING_ANNOTATION_STYLE_DEFAULTS.charUnderlineColor : READING_ANNOTATION_STYLE_DEFAULTS.underlineColor);
    return [
        `${mark}[data-style="highlight"] {`,
        `  background: ${readingMarkColor(highlightColor, 0.72)};`,
        "}",
        `${mark}[data-style="underline"] {`,
        `  border-bottom-color: ${readingMarkColor(underlineColor, 0.85)};`,
        "}",
    ].join("\n");
}

/** 一档批注卡片的样式。suffix 为空是 TA 的批注（也就是所有卡片的基准），
 *  [data-author="user"] 是用户自己的那档，权重更高，自然盖在基准上面。 */
function annotationCardCss(suffix: string, style: AnnotationCardStyle): string {
    const card = `.reading-app-surface .reading-annotation${suffix}`;
    return [
        `${card} {`,
        `  background: ${style.cardColor};`,
        "}",
        // 卡片顶上那截「胶带」跟着卡片颜色走，否则换了底色会留下一条不搭的旧色
        `${card}::before {`,
        `  background: ${readingMarkColor(style.cardColor, 0.6)};`,
        "}",
        // 悬浮批注卡里的正文也要吃这份字号：它挂在 .reading-floating-note-item 上，
        // 不是 .reading-annotation，只写前者的话悬浮卡会退回默认小字——外面那圈
        // 「正文用批注字体/字号」的规则根本选不中它。两处一起写。
        `${card} .reading-annotation-text,`,
        `${card} .reading-annotation-translation,`,
        `.reading-app-surface .reading-floating-note-item${suffix} .reading-annotation-text,`,
        `.reading-app-surface .reading-floating-note-item${suffix} .reading-annotation-translation {`,
        `  font-size: calc(${style.fontSize}px * var(--app-text-scale, 1));`,
        `  line-height: ${style.lineHeight};`,
        `  color: ${style.textColor};`,
        "}",
        `${card} .reading-annotation-name,`,
        `.reading-app-surface .reading-floating-note-item${suffix} .reading-annotation-name {`,
        `  font-size: calc(${Math.round(style.fontSize * 0.85 * 10) / 10}px * var(--app-text-scale, 1));`,
        `  color: ${style.textColor};`,
        "}",
    ].join("\n");
}

export default function ReadingApp({ onClose }: Props) {
    const [ready, setReady] = useState(false);
    const [activeBook, setActiveBook] = useState<Book | null>(null);
    /** 正在退出阅读 app：先把书架背后那棵阅读器摘掉，再真正关掉。 */
    const [exiting, setExiting] = useState(false);
    const [appearance, setAppearance] = useState<ReadingAppearance>(DEFAULT_READING_APPEARANCE);
    const [customCss, setCustomCss] = useState("");
    const resolvedCustomCss = useNightText(nightSlotKeys.reading, customCss);
    const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
    // 用着日间以外的搭配：文字颜色、背景、亮度换成那套配的，没配的项跟随日间
    const activeLookSet = useActiveLookSet();
    useNightRevision();
    const look = activeLookSet !== DAY_SET_ID ? loadReadingLook(activeLookSet) : null;
    const lookAsset = look?.background === "own" ? look.backgroundAsset : undefined;
    const [lookBackgroundUrl, setLookBackgroundUrl] = useState<string | null>(null);
    useEffect(() => {
        setLookBackgroundUrl(null);
        if (!lookAsset) return;
        let url: string | null = null;
        let cancelled = false;
        void loadReadingLookBackground({ background: "own", backgroundAsset: lookAsset }).then((blob) => {
            if (cancelled || !blob) return;
            url = URL.createObjectURL(blob);
            setLookBackgroundUrl(url);
        });
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [lookAsset]);
    const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
    const [annotationFontFamily, setAnnotationFontFamily] = useState<string | undefined>(undefined);
    const [userAnnotationFontFamily, setUserAnnotationFontFamily] = useState<string | undefined>(undefined);
    // Keep track of the last opened book so viewer stays mounted
    const lastBookRef = useRef<Book | null>(null);
    const backgroundUrlRef = useRef<string | null>(null);
    const customFontUrlRef = useRef<string | null>(null);
    const annotationFontUrlRef = useRef<string | null>(null);
    const userAnnotationFontUrlRef = useRef<string | null>(null);
    // 换字体时要把上一张 FontFace 从 document.fonts 摘掉：family 名带时间戳，
    // 不摘的话每次保存都会往文档里多挂一份字体，字体文件又不小。
    const customFontFaceRef = useRef<FontFace | null>(null);
    const annotationFontFaceRef = useRef<FontFace | null>(null);
    const userAnnotationFontFaceRef = useRef<FontFace | null>(null);
    if (activeBook) lastBookRef.current = activeBook;

    /** 退出阅读。阅读器在书架背后一直挂着（分页、批注、图片 objectURL 全在里面），
     *  它是最重的一块，卸载也最贵。这里把「摘掉阅读器」和「关掉 app」拆到两帧：
     *  前一帧先让退出动作有反馈，后一帧再关窗，否则「退出登录」点下去会先顿一下。 */
    const handleClose = () => {
        if (exiting) return;
        setExiting(true);
        if (typeof window === "undefined") { onClose(); return; }
        window.requestAnimationFrame(() => onClose());
    };

    const updateBackgroundUrl = (nextUrl: string | null) => {
        if (backgroundUrlRef.current && backgroundUrlRef.current !== nextUrl) {
            URL.revokeObjectURL(backgroundUrlRef.current);
        }
        backgroundUrlRef.current = nextUrl;
        setBackgroundUrl(nextUrl);
    };

    const loadFontFace = async (
        blob: Blob | null,
        urlRef: React.MutableRefObject<string | null>,
        faceRef: React.MutableRefObject<FontFace | null>,
        setFamily: (family: string | undefined) => void,
        familyPrefix: string,
    ) => {
        if (faceRef.current) {
            try { document.fonts.delete(faceRef.current); } catch { /* 老浏览器没有 delete，忽略 */ }
            faceRef.current = null;
        }
        if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = null;
        }
        setFamily(undefined);
        if (!blob || typeof FontFace === "undefined") return;

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const familyName = `${familyPrefix}_${Date.now()}`;

        try {
            const face = new FontFace(familyName, `url("${url}")`);
            await face.load();
            document.fonts.add(face);
            faceRef.current = face;
            setFamily(`"${familyName}"`);
        } catch {
            setFamily(undefined);
        }
    };

    const loadCustomFontFace = (blob: Blob | null) =>
        loadFontFace(blob, customFontUrlRef, customFontFaceRef, setCustomFontFamily, "AIVirtualPhoneReadingFont");

    const loadAnnotationFontFace = (blob: Blob | null) =>
        loadFontFace(blob, annotationFontUrlRef, annotationFontFaceRef, setAnnotationFontFamily, "AIVirtualPhoneReadingAnnotationFont");

    const loadUserAnnotationFontFace = (blob: Blob | null) =>
        loadFontFace(blob, userAnnotationFontUrlRef, userAnnotationFontFaceRef, setUserAnnotationFontFamily, "AIVirtualPhoneReadingUserAnnotationFont");

    useEffect(() => {
        void (async () => {
            // 外观存在 kv 里，而 kv 的同步缓存要等 hydrate 完才有内容。先读会拿到空缓存，
            // 于是整套外观静默退回默认值——用户看到的就是「设置根本没保存上」。
            await Promise.all([hydrateKvDb(), hydrateReadingStorage()]).catch(() => {});
            setAppearance(loadReadingAppearance());
            setCustomCss(loadReadingCustomCss());
            setReady(true);
            // 串行读取：这几项共用同一个 IndexedDB。并发打开时，若库缺 store 需要升版本补建，
            // 会被其它尚未关闭的连接 block 掉。顺序执行可以保证同一时刻只有一个连接。
            const background = await loadReadingBackground();
            updateBackgroundUrl(background ? URL.createObjectURL(background) : null);
            await loadCustomFontFace(await loadReadingCustomFont());
            await loadAnnotationFontFace(await loadReadingAnnotationFont());
            await loadUserAnnotationFontFace(await loadReadingUserAnnotationFont());
        })();
        return () => {
            if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
            if (customFontUrlRef.current) URL.revokeObjectURL(customFontUrlRef.current);
            if (annotationFontUrlRef.current) URL.revokeObjectURL(annotationFontUrlRef.current);
            if (userAnnotationFontUrlRef.current) URL.revokeObjectURL(userAnnotationFontUrlRef.current);
            for (const faceRef of [customFontFaceRef, annotationFontFaceRef, userAnnotationFontFaceRef]) {
                if (!faceRef.current) continue;
                try { document.fonts.delete(faceRef.current); } catch { /* 老浏览器没有 delete，忽略 */ }
                faceRef.current = null;
            }
        };
    }, []);

    const handleSaveAppearance = async (
        nextAppearance: ReadingAppearance,
        options: ReadingAppearanceSaveOptions,
    ) => {
        const normalized = saveReadingAppearance(nextAppearance);
        setAppearance(normalized);
        // 自定义 CSS 和外观一起保存。放在最前面：下面几个分支会 early return
        setCustomCss(saveReadingCustomCss(options.customCss));
        // 某套搭配的文字颜色和背景（弹窗顶上切到那套时改的）
        if (options.readingLook) {
            await saveReadingLook(options.readingLook.setId, options.readingLook.look, options.readingLook.backgroundFile);
        }

        // 放在下面几个 early return 之前：原有分支里清背景/清字体都会直接 return，
        // 挂在后面的话「同时改背景和批注字体」就会被吞掉。
        if (options.clearAnnotationFont) {
            await saveReadingAnnotationFont(null);
            await loadAnnotationFontFace(null);
        } else if (options.annotationFontFile) {
            await saveReadingAnnotationFont(options.annotationFontFile);
            await loadAnnotationFontFace(options.annotationFontFile);
        }

        if (options.clearUserAnnotationFont) {
            await saveReadingUserAnnotationFont(null);
            await loadUserAnnotationFontFace(null);
        } else if (options.userAnnotationFontFile) {
            await saveReadingUserAnnotationFont(options.userAnnotationFontFile);
            await loadUserAnnotationFontFace(options.userAnnotationFontFile);
        }

        if (options.clearBackground) {
            await saveReadingBackground(null);
            updateBackgroundUrl(null);
            return;
        }

        if (options.backgroundFile) {
            await saveReadingBackground(options.backgroundFile);
            updateBackgroundUrl(URL.createObjectURL(options.backgroundFile));
        }

        if (options.clearCustomFont) {
            await saveReadingCustomFont(null);
            await loadCustomFontFace(null);
            return;
        }

        if (options.customFontFile) {
            await saveReadingCustomFont(options.customFontFile);
            await loadCustomFontFace(options.customFontFile);
        }
    };

    // 亮度是盖在背景图上的一层纯色，和图一起塞进同一个变量，
    // 这样所有用到 --reading-bg-image 的地方（书架、阅读页、翻页动画）都自动跟着变。
    const shownBrightness = look?.backgroundBrightness ?? appearance.backgroundBrightness;
    const shownBackgroundUrl = look?.background === "own" ? lookBackgroundUrl : look?.background === "none" ? null : backgroundUrl;
    const backgroundOverlay = readingBackgroundOverlay(shownBrightness);
    const backgroundLayers = shownBackgroundUrl
        ? (backgroundOverlay ? `${backgroundOverlay}, url("${shownBackgroundUrl}")` : `url("${shownBackgroundUrl}")`)
        : "none";
    const resolvedAnnotationFont = resolveReadingAnnotationFontFamily(appearance.annotationFontFamily, annotationFontFamily);
    const resolvedUserAnnotationFont = resolveReadingAnnotationFontFamily(appearance.userAnnotationFontFamily, userAnnotationFontFamily);
    const resolvedBodyFont = resolveReadingFontFamily(appearance.fontFamily, customFontFamily);

    const annotationStyle = {
        fontSize: appearance.annotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize,
        lineHeight: appearance.annotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight,
        textColor: appearance.annotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.textColor,
        cardColor: appearance.annotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.cardColor,
    };
    const userAnnotationStyle = {
        fontSize: appearance.userAnnotationFontSize ?? READING_ANNOTATION_STYLE_DEFAULTS.fontSize,
        lineHeight: appearance.userAnnotationLineHeight ?? READING_ANNOTATION_STYLE_DEFAULTS.lineHeight,
        textColor: appearance.userAnnotationTextColor || READING_ANNOTATION_STYLE_DEFAULTS.userTextColor,
        cardColor: appearance.userAnnotationCardColor || READING_ANNOTATION_STYLE_DEFAULTS.userCardColor,
    };

    // 字体由这段注入的 <style> 统一下发，而不是靠「根节点内联 + 继承」。
    //
    // 起因：用户的全局自定义 CSS 里有一条普通优先级的字体规则，它打不过带声明的
    // 元素，却稳稳打赢「继承」——于是正文 <p>、书架标题 <h1> 这些靠继承拿字体的
    // 元素全被接管，而批注是 <span>、没被那条规则选中，反倒一直是对的。这类事故
    // 以后还会有（插件、主题、自定义 CSS 都能注入全局样式），所以阅读区的字体给成
    // 真正的声明、并且带上一点选择器权重，别再把它挂在最弱的继承上。
    // 这里刻意不用 !important：用户想用自定义 CSS 精细覆盖阅读样式时还能盖得动。
    //
    // 排除项：设置里的字体样张和诊断报告要保留自己的字体，否则预览就没意义了。
    // :where() 本身不带权重，所以整条规则只有「一个 class」那么重：
    // 足以压过 p{} / body *{} 这类全局规则，又不至于让用户没法再覆盖它。
    const FONT_EXCLUDES = ":not(:where(.reading-font-preview, .reading-font-diag-report,"
        + " .reading-annotation-name, .reading-annotation-text, .reading-annotation-translation))";
    const readingFontCss = [
        [
            ".reading-app-surface,",
            `.reading-app-surface *${FONT_EXCLUDES} {`,
            `  font-family: ${resolvedBodyFont};`,
            "}",
        ].join("\n"),
        [
            ".reading-app-surface .reading-annotation-name,",
            ".reading-app-surface .reading-annotation-text,",
            ".reading-app-surface .reading-annotation-translation {",
            `  font-family: ${resolvedAnnotationFont || resolvedBodyFont};`,
            "}",
        ].join("\n"),
        resolvedUserAnnotationFont && [
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-name,',
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-text,',
            '.reading-app-surface .reading-annotation[data-author="user"] .reading-annotation-translation,',
            // 悬浮批注卡同样要吃「用户批注字体」
            '.reading-app-surface .reading-floating-note-item[data-author="user"] .reading-annotation-text,',
            '.reading-app-surface .reading-floating-note-item[data-author="user"] .reading-annotation-translation {',
            `  font-family: ${resolvedUserAnnotationFont};`,
            "}",
        ].join("\n"),
        // 提示词输入框保持等宽，别被上面那条通吃规则带走
        [
            ".reading-app-surface .reading-settings-prompt textarea,",
            ".reading-app-surface .chat-bilingual-prompt-textarea {",
            "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;",
            "}",
        ].join("\n"),
        // 批注卡片：字号、行距、文字颜色、卡片底色。名字那行按正文的 0.85 缩放，
        // 否则把批注字号调大以后，署名还是原来那么小，看着像没跟上。
        annotationCardCss("", annotationStyle),
        annotationCardCss('[data-author="user"]', userAnnotationStyle),
        // 正文文字排版对齐（左对齐 / 右对齐 / 居中对齐 / 两端对齐）
        (() => {
            const align = appearance.textAlign ?? "justify";
            return [
                ".reading-app-surface .reading-line,",
                ".reading-app-surface .reading-paragraph {",
                `  text-align: ${align};`,
                `  text-align-last: ${align};`,
                "}",
                ".reading-app-surface .reading-line-seg-end {",
                `  text-align-last: ${align === "justify" ? "left" : align};`,
                "}",
            ].join("\n");
        })(),
        // 高亮 / 划线的颜色。自己划的和角色划的分开配，默认也不是一个色系，
        // 一眼看得出这道线是谁划的。没有 data-author 的老数据算自己划的。
        markColorCss("", appearance.highlightColor, appearance.underlineColor),
        markColorCss('[data-author="character"]', appearance.charHighlightColor, appearance.charUnderlineColor, true),
        // 悬浮批注卡：点🪶弹出，盖在正文上方，不参与排版。
        // 位置由阅读器算好写成内联 top/left，这里只管长相。
        [
            /* 和正文同宽：左右各让出 16px（正文那层 px-4），居中摆放。
               位置不能靠 translateX(-50%) + 锚点像素：手机壳整体 scale 过，
               rect 拿到的是缩放后的尺寸，会和卡片自身布局宽度对不上。
               卡片本体也绝对不能带 overflow —— 三角是从卡片外沿探出去的，
               一裁就看不见了（第一版就是这么没影的），滚动交给内层。 */
            ".reading-floating-note-card {",
            "  position: absolute;",
            "  z-index: 60;",
            "  box-sizing: border-box;",
            "  left: 16px;",
            "  right: 16px;",
            "  margin: 0 auto;",
            "  border-radius: 10px;",
            "  background: #ffffff;",
            /* 删掉描边，改用向下投影定边界 */
            "  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);",
            "}",
            ".reading-floating-note-scroll {",
            "  max-height: 46vh;",
            "  overflow-y: auto;",
            "  padding: 10px 12px 9px;",
            "  border-radius: inherit;",
            "  overscroll-behavior: contain;",
            "}",
            ".reading-floating-note-card--above {",
            "  transform: translateY(-100%);",
            "}",
            /* 贴边三角：指向那枚羽毛。上方的卡尖朝下，下方的卡尖朝上 */
            ".reading-floating-note-card::before,",
            ".reading-floating-note-card::after {",
            '  content: "";',
            "  position: absolute;",
            /* 三角横向跟着那枚羽毛走（--reading-note-arrow 由阅读器按羽毛位置写进来） */
            "  left: var(--reading-note-arrow, 50%);",
            "  width: 0;",
            "  height: 0;",
            "  pointer-events: none;",
            "}",
            ".reading-floating-note-card::before {",
            "  margin-left: -8px;",
            "  border-left: 8px solid transparent;",
            "  border-right: 8px solid transparent;",
            "}",
            ".reading-floating-note-card::after {",
            "  margin-left: -7px;",
            "  border-left: 7px solid transparent;",
            "  border-right: 7px solid transparent;",
            "}",
            ".reading-floating-note-card:not(.reading-floating-note-card--above)::before {",
            "  top: -8px;",
            "  border-bottom: 8px solid rgba(0, 0, 0, 0.10);",
            "}",
            ".reading-floating-note-card:not(.reading-floating-note-card--above)::after {",
            "  top: -7px;",
            "  border-bottom: 7px solid #ffffff;",
            "}",
            ".reading-floating-note-card--above::before {",
            "  bottom: -8px;",
            "  border-top: 8px solid rgba(0, 0, 0, 0.10);",
            "}",
            ".reading-floating-note-card--above::after {",
            "  bottom: -7px;",
            "  border-top: 7px solid #ffffff;",
            "}",
            /* 第一条和最后一条之间的距离交给分割线，卡片不留多余空白 */
            ".reading-floating-note-item > .reading-annotation-text:last-child {",
            "  margin-bottom: 0;",
            "}",
            ".reading-floating-note-item .reading-annotation-text {",
            "  margin: 0 0 12px;",
            "}",
            ".reading-floating-note-divider {",
            "  height: 1px;",
            "  margin: 8px -12px;",
            "  background: rgba(0, 0, 0, 0.08);",
            "}",
            /* 第二行：头像贴左，右侧名字与时间戳上下两行，整体垂直居中 */
            ".reading-floating-note-meta {",
            "  display: flex;",
            "  align-items: center;",
            "  gap: 9px;",
            "}",
            ".reading-floating-note-avatar {",
            "  flex: 0 0 auto;",
            "  width: 30px;",
            "  height: 30px;",
            "  border-radius: 50%;",
            "  overflow: hidden;",
            "  display: grid;",
            "  place-items: center;",
            "  background: rgba(0, 0, 0, 0.06);",
            "  color: rgba(0, 0, 0, 0.45);",
            "  font-size: calc(12px * var(--app-text-scale, 1));",
            "  font-weight: 500;",
            "}",
            ".reading-floating-note-avatar img {",
            "  width: 100%;",
            "  height: 100%;",
            "  object-fit: cover;",
            "  display: block;",
            "}",
            ".reading-floating-note-author {",
            "  flex: 1 1 auto;",
            "  min-width: 0;",
            "  display: flex;",
            "  flex-direction: column;",
            "  gap: 2px;",
            "}",
            ".reading-floating-note-name {",
            "  flex: 1 1 auto;",
            "  min-width: 0;",
            "  overflow: hidden;",
            "  text-overflow: ellipsis;",
            "  white-space: nowrap;",
            "  font-size: calc(12.5px * var(--app-text-scale, 1));",
            "  font-weight: 500;",
            "  line-height: 1.2;",
            "  color: #222222;",
            "}",
            ".reading-floating-note-time {",
            "  font-size: calc(11px * var(--app-text-scale, 1));",
            "  line-height: 1.25;",
            "  color: #888888;",
            "  font-variant-numeric: tabular-nums;",
            "}",
            ".reading-floating-note-item {",
            "  position: relative;",
            "  border-radius: 8px;",
            "  padding: 4px 6px;",
            "  margin: 0 -6px;",
            "  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.25, 1), background-color 160ms ease, box-shadow 180ms ease;",
            "  cursor: pointer;",
            "}",
            /* 多条批注时，被点选的那条卡片轻微放大浮起，且背景浅底凸显，与未选中条目有明显视觉区分 */
            ".reading-floating-note-item.is-target {",
            "  background: rgba(0, 0, 0, 0.04);",
            "  transform: scale(1.025);",
            "  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.07);",
            "  z-index: 2;",
            "}",
            /* 卡片外侧固定的横向操作条：
               在卡片下方时：位于下方外侧间距 3px，右侧对齐；
               在卡片上方时：位于上方外侧间距 3px，右侧对齐；
               未展开时只显示箭头按钮；点击后向左侧平滑展开修改/复制/删除 */
            ".reading-note-menu {",
            "  position: absolute;",
            "  z-index: 70;",
            "  right: 0;",
            "  display: inline-flex;",
            "  align-items: center;",
            "  box-sizing: border-box;",
            "  border-radius: 6px;",
            "  background: #ffffff;",
            "  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);",
            "  overflow: hidden;",
            "}",
            ".reading-note-menu[data-place=\"below\"] {",
            "  top: calc(100% + 3px);",
            "}",
            ".reading-note-menu[data-place=\"above\"] {",
            "  bottom: calc(100% + 3px);",
            "}",
            ".reading-note-menu-expand {",
            "  display: inline-flex;",
            "  align-items: center;",
            "  max-width: 0;",
            "  opacity: 0;",
            "  overflow: hidden;",
            "  transition: max-width 220ms cubic-bezier(0.2, 0.8, 0.25, 1), opacity 180ms ease;",
            "  pointer-events: none;",
            "}",
            ".reading-note-menu-expand.is-expanded {",
            "  max-width: 220px;",
            "  opacity: 1;",
            "  pointer-events: auto;",
            "}",
            ".reading-note-menu-item {",
            "  flex: 0 0 auto;",
            "  display: inline-flex;",
            "  align-items: center;",
            "  justify-content: center;",
            "  height: 30px;",
            "  padding: 0 11px;",
            "  border: none;",
            "  background: transparent;",
            "  color: #222222;",
            "  font-size: calc(12px * var(--app-text-scale, 1));",
            "  font-weight: 500;",
            "  line-height: 1;",
            "  white-space: nowrap;",
            "  cursor: pointer;",
            "  -webkit-tap-highlight-color: transparent;",
            "}",
            ".reading-note-menu-item:active {",
            "  background: rgba(0, 0, 0, 0.06);",
            "}",
            ".reading-note-menu-item--danger {",
            "  color: #cc2200;",
            "}",
            ".reading-note-menu-divider {",
            "  flex: 0 0 auto;",
            "  width: 1px;",
            "  height: 14px;",
            "  background: rgba(0, 0, 0, 0.12);",
            "}",
            ".reading-note-menu-toggle-btn {",
            "  flex: 0 0 auto;",
            "  display: inline-flex;",
            "  align-items: center;",
            "  justify-content: center;",
            "  width: 30px;",
            "  height: 30px;",
            "  padding: 0;",
            "  border: none;",
            "  background: transparent;",
            "  color: #555555;",
            "  cursor: pointer;",
            "  transition: transform 180ms ease, color 140ms ease;",
            "  -webkit-tap-highlight-color: transparent;",
            "}",
            ".reading-note-menu-toggle-btn:active {",
            "  background: rgba(0, 0, 0, 0.06);",
            "  color: #111111;",
            "}",
            ".reading-note-menu-toggle-btn svg {",
            "  transition: transform 200ms ease;",
            "}",
            ".reading-note-menu-toggle-btn.is-expanded svg {",
            "  transform: rotate(-90deg);",
            "}",
        ].join("\n"),
    ].filter(Boolean).join("\n");

    const appearanceStyle = {
        fontFamily: resolvedBodyFont,
        // 三个字体变量继续下发：新版 CSS 已经不读它们了，但用户手机上可能还缓存着
        // 旧版 CSS（PWA 的 Service Worker 会把整套静态资源存下来）。旧规则读到变量
        // 就还能正常显示，读不到则回落成系统字体——正是「换了字体没反应」的样子。
        ["--reading-font-family" as "--reading-font-family"]: resolvedBodyFont,
        ...(resolvedAnnotationFont
            ? { ["--reading-annotation-font-family" as "--reading-annotation-font-family"]: resolvedAnnotationFont }
            : {}),
        ...(resolvedUserAnnotationFont
            ? { ["--reading-user-annotation-font-family" as "--reading-user-annotation-font-family"]: resolvedUserAnnotationFont }
            : {}),
        ["--reading-font-size" as "--reading-font-size"]: `${appearance.fontSize}px`,
        ["--reading-text-color" as "--reading-text-color"]: look?.textColor || appearance.textColor,
        ["--reading-line-height" as "--reading-line-height"]: String(appearance.lineHeight),
        ["--reading-text-align" as "--reading-text-align"]: appearance.textAlign ?? "justify",
        ["--reading-text-align-last" as "--reading-text-align-last"]: (appearance.textAlign ?? "justify") === "justify" ? "left" : (appearance.textAlign ?? "justify"),
        ["--reading-bg-image" as "--reading-bg-image"]: backgroundLayers,
    } as CSSProperties;
    // 传给阅读器，让它在字体/字号/行距变化后重新分页。批注字体也算进来：
    // 翻页模式连批注块的高度一起量，批注换字体同样会改变每页塞得下多少东西。
    const appearanceKey = [
        appearance.fontSize,
        appearance.lineHeight,
        resolvedBodyFont,
        resolvedAnnotationFont || "",
        resolvedUserAnnotationFont || "",
        // 批注的字号和行距也会改变卡片高度，翻页模式得重新分页
        annotationStyle.fontSize,
        annotationStyle.lineHeight,
        userAnnotationStyle.fontSize,
        userAnnotationStyle.lineHeight,
    ].join("|");
    const hiddenViewerStyle = {
        position: "absolute",
        inset: 0,
        visibility: "hidden",
        pointerEvents: "none",
    } as CSSProperties;

    if (!ready) return <div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "#fffced" }}><span className="ts-14" style={{ color: "#a39487" }}>加载中...</span></div>;

    return (
        <div className="absolute inset-0" style={appearanceStyle}>
            <style>{readingFontCss}</style>
            {/* 用户自己写的阅读 CSS 放在最后，才盖得过上面那几条 */}
            {resolvedCustomCss && <style>{resolvedCustomCss}</style>}
            {!activeBook && (
                <ReadingShelf
                    onOpenBook={setActiveBook}
                    onDeleteBook={(deletedBookId) => {
                        if (lastBookRef.current?.id === deletedBookId) {
                            lastBookRef.current = null;
                        }
                    }}
                    onClose={handleClose}
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    loadedFonts={{
                        body: customFontFamily,
                        annotation: annotationFontFamily,
                        userAnnotation: userAnnotationFontFamily,
                    }}
                    onSaveAppearance={handleSaveAppearance}
                />
            )}
            {lastBookRef.current && !exiting && (
                <div style={activeBook ? undefined : hiddenViewerStyle} aria-hidden={!activeBook}>
                    <ReadingViewer book={lastBookRef.current} appearanceKey={appearanceKey} onBack={() => setActiveBook(null)} />
                </div>
            )}
        </div>
    );
}
