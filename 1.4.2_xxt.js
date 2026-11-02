// ==UserScript==
// @name         学习通绕过解锁粘贴限制
// @namespace    https://github.com/suyu-ops/chaoxing-paste-unlock
// @version      1.4.2
// @description  解锁学习通全部粘贴限制（含考试/测验与学校定制版），覆盖代码编辑区、UE编辑器、讨论区，保留原生粘贴与图片上传
// @author       suyu
// @match        *://*.chaoxing.com/*
// @match        *://mooc1-*.chaoxing.com/*
// @match        *://*.edu.cn/*
// @match        *://*.edu.hk/*
// @match        *://*.100.com/*
// @match        *://*.chaoxing.net/*
// @grant        unsafeWindow
// @run-at       document-start
// @tag          学习通
// @tag          粘贴限制
// @license      CC BY-NC-SA 4.0
// @license      https://creativecommons.org/licenses/by-nc-sa/4.0/
// @original-author  Muyue
// @original-license CC BY-NC-SA 4.0
// @original-script  https://scriptcat.org/zh-CN/script-show-page/4835
// ==/UserScript==
//
// ---------------------------------------------------------------
// 本脚本基于 @original-script 修改，沿用原作品 CC BY-NC-SA 4.0 许可。
//   非商业用途；再分发须保留本段及同一许可。
//   修改者：suyu
// ---------------------------------------------------------------
//
// ---------------------------- 1.4.2 ----------------------------
// 适配
//  · CodeMirror 5 / CodeMirror 6 / UEditor 三套编辑器统一处理
//  · 主文档与同源 iframe 自动扫描，SPA 路由切换后自动重新挂载
//
// 粘贴行为
//  · 不接管图片与附件：剪贴板含文件时直接放行，交给平台原生的上传链路
//  · 纯文本按编辑器类型分别处理：
//      CM5  捕获阶段记录，交给 CodeMirror 原生插入
//      CM6  直接 dispatch，标记为普通输入事件
//      UE   优先走 execCommand，失败则按 enterTag 生成段落后插入 DOM
//  · 站点在 beforepaste 里清空内容时，按调用前后的差异还原
//
// 稳定性
//  · UEditor 未 ready 时排队，ready 回调只注册一次，避免重复插入
//  · 补插只发生在文档确实没有变化时，位置取粘贴瞬间的选区快照
//  · UEditor 监听器原地包装，不改变数组长度，避免同一事件的其他监听被跳过
//  · 选区在失焦前记录，插入前恢复，避免内容落到文首
//  · 插入后同步编辑器状态，页面能感知到内容变化
//
// 全站限制
//  · 所有 *.chaoxing.com 页面生效，包含考试与测验
//  · 支持部署在学校自有域名上的定制版；非学习通页面自动跳过
//  · 同时解除右键菜单、文本选择、Ctrl/Cmd + V/X/C/A 的拦截
//  · 强制放开 user-select，页面无法通过样式禁止选中
//  · 通用守卫按区域判定，不干扰代码编辑器与 UEditor 自身的输入链路
//
// 其它
//  · 单一轮询，页面隐藏时暂停，长时间无命中自动降频
//  · 剪贴板零宽字符写入在粘贴窗口内被忽略
//  · 讨论区只解除粘贴开关，不修改任何身份字段
// ---------------------------------------------------------------

(function () {
    'use strict';

    var w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    var TAG = '[Unified-Paste]';
    var MARK = '只能录入不能粘贴';
    var NOTICE = '已绕过粘贴限制 By.suyu';
    var CM_SEL = '.CodeMirror, .cm-editor, .cm-content, .cm-scroller, .cm-line';

    function log() {
        try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {}
    }

    try {
        if (w.__xxtPasteUnlock) return;
        w.__xxtPasteUnlock = '1.4.2';
    } catch (e) {}

    function doc() { try { return w.document || document; } catch (e) { return document; } }

    /* ============================================================
     * 站点识别：定制版学习通部署在 *.edu.cn / *.100.com 等学校域名上，
     * 不能只看域名就动手，必须确认页面确实是学习通再启用。
     * 命中条件（任一）：
     *   1. 域名本身属于超星（chaoxing.com / chaoxing.net）
     *   2. 页面存在超星的特征全局对象或资源路径
     * 未命中则整个脚本静默退出，不影响学校站点正常功能。
     * ============================================================ */
    function isChaoxingHost() {
        try {
            var h = String(w.location && w.location.hostname || '').toLowerCase();
            if (!h) return false;
            if (/(^|\.)chaoxing\.(com|net)$/.test(h)) return true;
            return false;
        } catch (e) { return false; }
    }

    // 只在非超星域名上做一次特征检测；检测到才继续
    function detectChaoxingPage() {
        if (isChaoxingHost()) return true;
        try {
            if (w.UE && w.UE.instants) return true;                    // UEditor 实例表
            if (w.UEDITOR_CONFIG) return true;                          // UEditor 配置
            if (w.codeEditors && typeof w.codeEditors === 'object') return true;  // 代码题实例表
            if (typeof w.editorPaste === 'function') return true;       // 作业页注入的粘贴回调
            var scripts = doc().querySelectorAll('script[src]');
            for (var i = 0; i < scripts.length; i++) {
                var src = scripts[i].getAttribute('src') || '';
                if (/chaoxing|ueditor\.all|codeEditor\.js|star3/i.test(src)) return true;
            }
            // 页面内联脚本里出现过超星接口特征
            var html = '';
            try { html = doc().documentElement && doc().documentElement.innerHTML || ''; } catch (e) {}
            if (/ananas\.chaoxing\.com|passport2?\.chaoxing\.com|mooc1?\.chaoxing\.com/i.test(html)) return true;
        } catch (e) {}
        return false;
    }

    /* ---------------- toast ---------------- */
    var noticeAt = {};
    function showNotice(msg) {
        var now = Date.now();
        if (now - (noticeAt[msg] || 0) < 3000) return;
        noticeAt[msg] = now;
        try {
            if (w.$ && typeof w.$.toast === 'function') { w.$.toast({ type: 'notice', content: msg }); return; }
        } catch (e) {}
        log(msg);
    }

    /* ---------------- 文本工具 ---------------- */
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 块级闭合补 \n + textarea(RCDATA) 解实体。不建 DOM、不执行脚本、不加载图片。
    function htmlToText(html) {
        try {
            var s = String(html)
                .replace(/<\s*br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)\s*>/gi, '\n')
                .replace(/<[^>]*>/g, '');
            var ta = doc().createElement('textarea');
            ta.innerHTML = s;
            return ta.value
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^\n+|\n+$/g, '');
        } catch (e) { return ''; }
    }

    function textToUeHtml(text, enterTag) {
        var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        if (enterTag === 'br') return lines.map(esc).join('<br/>');
        return lines.map(function (l) { return '<p>' + (l ? esc(l) : '<br/>') + '</p>'; }).join('');
    }

    function clipboardHasFile(cd) {
        if (!cd) return false;
        try {
            if (cd.items) for (var i = 0; i < cd.items.length; i++) if (cd.items[i].kind === 'file') return true;
            if (cd.files && cd.files.length) return true;
            if (cd.types) for (var j = 0; j < cd.types.length; j++) if (cd.types[j] === 'Files') return true;
        } catch (e) {}
        return false;
    }

    function clipboardText(cd) {
        var t = '';
        try { t = cd.getData('text/plain') || cd.getData('Text') || ''; } catch (e) {}
        if (t) return t;
        try {
            var h = cd.getData('text/html');
            if (h) return htmlToText(h);
        } catch (e) {}
        return '';
    }

    /* ============================================================
     * UEditor：行为判定，不信源码
     * ============================================================ */

    // 只用来"精确识别以便连 toast 一起干掉"；识别失败也不影响功能（有行为兜底）
    function looksLikeBlocker(fn) {
        if (typeof fn !== 'function' || fn.__xxtPass) return false;
        try {
            var src = Function.prototype.toString.call(fn);
            if (src.indexOf(MARK) !== -1) return true;
            return /html\s*\.\s*html\s*=\s*['"]{2}/.test(src);
        } catch (e) { return false; }
    }

    // 调用监听器前后比对 html.html 快照；被清空则还原。
    function guardBeforePaste(listener) {
        if (typeof listener !== 'function' || listener.__xxtGuard) return listener;
        var guarded = function (html) {
            var snapshot = html && html.html;
            var r;
            try { r = listener.apply(this, arguments); } catch (e) { r = undefined; }
            if (html && !html.html && snapshot) {
                html.html = snapshot;                       // 被清空 → 还原，内容照插
                showNotice(NOTICE);
            }
            return r;
        };
        guarded.__xxtGuard = true;
        guarded.__xxtOrig = listener;
        return guarded;
    }

    var passthrough = function () { return true; };
    passthrough.__xxtPass = true;

    var editorPasteRef = passthrough;

    function applyEditorPaste(fn) {
        // 这个槽位按定义就是粘贴回调；站点挂上去的一律当拦截器（自研，不依赖文案）
        if (typeof fn === 'function' && !fn.__xxtPass) {
            editorPasteRef = passthrough;
            log('editorPaste slot neutralized', looksLikeBlocker(fn) ? '(identified)' : '(unidentified)');
            return;
        }
        if (typeof fn === 'function') editorPasteRef = fn;
    }

    function wrapAddListener(owner) {
        if (!owner || typeof owner.addListener !== 'function' || owner.addListener.__xxt) return;
        var raw = owner.addListener;
        var wrapped = function (type, fn) {
            if ((type === 'beforepaste' || type === 'beforePaste') && typeof fn === 'function') {
                if (looksLikeBlocker(fn)) {                     // 认得出来：连 toast 一起干掉
                    log('dropped beforepaste', this && (this.key || this.uid));
                    return this;
                }
                return raw.call(this, type, guardBeforePaste(fn));   // 认不出：包行为兜底
            }
            return raw.apply(this, arguments);
        };
        wrapped.__xxt = true;
        try { owner.addListener = wrapped; } catch (e) {}
    }

    // 原地替换元素，不改变数组长度（UE 的 fireEvent 倒序遍历同一数组，删除会跳过相邻项）
    function guardEditor(editor) {
        if (!editor) return;
        wrapAddListener(editor);
        var all = editor.__allListeners;
        if (!all) return;
        var list = all.beforepaste;
        if (!list || !list.length) return;
        for (var i = 0; i < list.length; i++) {
            var fn = list[i];
            if (typeof fn !== 'function') continue;
            if (looksLikeBlocker(fn)) {
                list[i] = null;                                 // 留 null，fireEvent 里有 `if (!listeners[k]) continue`
                log('neutralized beforepaste listener', editor.key || editor.uid);
            } else if (!fn.__xxtGuard) {
                list[i] = guardBeforePaste(fn);
            }
        }
    }

    function enablePasteFile(editor) {
        var o = editor && editor.options;
        if (!o) return;
        if (o.disablePasteImage !== false) o.disablePasteImage = false;
        if (o.disableDraggable !== false) o.disableDraggable = false;
    }

    // 只在值真的是 true 时才写，避免每拍无条件改配置对象
    function patchUeConfig() {
        try {
            var cfg = w.UEDITOR_CONFIG;
            if (!cfg) return;
            if (cfg.disablePasteImage !== false) cfg.disablePasteImage = false;
            if (cfg.disableDraggable !== false) cfg.disableDraggable = false;
        } catch (e) {}
    }

    /* ---- 选区记忆：UEditor 与 CodeMirror 都需要 ---- */
    var ueRanges = new WeakMap();

    function rememberUeRange(editor) {
        try {
            var sel = editor && editor.selection;
            var r = sel && typeof sel.getRange === 'function' ? sel.getRange() : null;
            if (r && typeof r.cloneRange === 'function') ueRanges.set(editor, r.cloneRange());
        } catch (e) {}
    }

    function restoreUeRange(editor) {
        var r = ueRanges.get(editor);
        if (!r) return false;
        try {
            if (typeof r.select === 'function') { r.select(); return true; }
        } catch (e) {}
        return false;
    }

    function bindUeSelection(editor, d) {
        if (d.__xxtSelBound) return;
        d.__xxtSelBound = true;
        ['mouseup', 'keyup', 'selectionchange'].forEach(function (t) {
            try { d.addEventListener(t, function () { rememberUeRange(editor); }, true); } catch (e) {}
        });
        try { editor.addListener('focus', function () { rememberUeRange(editor); }); } catch (e) {}
    }

    /* ---- 插入后通知平台 ---- */
    function notifyUeChanged(editor, d) {
        // UE 的 execCommand 内部会 fireEvent('contentchange')，但页面的 answerContentChange()
        // 只挂在 contentChange 监听上、UE 不会替我们调；不显式通知，离开页面会弹"可能不会保存"。
        try { editor.fireEvent('contentchange'); } catch (e) {}
        try { editor.fireEvent('contentChange'); } catch (e) {}
        try { if (typeof w.answerContentChange === 'function') w.answerContentChange(); } catch (e) {}
        try {
            if (d) d.dispatchEvent(new w.Event('selectionchange'));
            w.dispatchEvent(new w.Event('resize'));
        } catch (e) {}
    }

    /* ---- 插入 ---- */
    function ueBodyLen(editor) {
        try { return (editor.body && (editor.body.innerHTML || '').length) || 0; } catch (e) { return 0; }
    }

    function ueInsertAtRange(editor, text) {
        try {
            var body = editor.body;
            var d = body.ownerDocument;
            var sel = d.getSelection();
            var html = textToUeHtml(text, (editor.options && editor.options.enterTag) || 'p');
            var box = d.createElement('div');
            box.innerHTML = html;
            var frag = d.createDocumentFragment();
            while (box.firstChild) frag.appendChild(box.firstChild);
            if (sel && sel.rangeCount && sel.anchorNode && body.contains(sel.anchorNode)) {
                var r = sel.getRangeAt(0);
                r.deleteContents();
                r.insertNode(frag);
                sel.collapseToEnd();
            } else {
                body.appendChild(frag);
            }
            notifyUeChanged(editor, d);
            return true;
        } catch (e) { log('ue range insert failed', e); return false; }
    }

    // ready 未完成时排队；ready 回调只注册一次，避免连点触发重复插入
    var ueQueues = new WeakMap();     // editor -> { pending: [text], asked: bool }

    function ueInsertNow(editor, text) {
        try { editor.focus(); } catch (e) {}
        restoreUeRange(editor);
        var enter = (editor.options && editor.options.enterTag) || 'p';
        var html = textToUeHtml(text, enter);
        var before = ueBodyLen(editor);
        // 只用一个名字：UEditor 的 execCommand 内部会 cmdName.toLowerCase()，
        // 'insertHtml' 与 'inserthtml' 是同一个命令，试两个等于执行两次。
        try { editor.execCommand('inserthtml', html); } catch (e) { log('inserthtml threw', e); }
        if (ueBodyLen(editor) !== before) {
            notifyUeChanged(editor, editor.body && editor.body.ownerDocument);
            return true;
        }
        log('inserthtml no-op, fallback to range insert');
        return ueInsertAtRange(editor, text);
    }

    function ueIsReady(editor) {
        try {
            // isReady 存在时以它为准：UE 在 ready 之前 body 可能已经有 ownerDocument，
            // 但 execCommand 仍会被 _beforeExecCommand 丢弃。
            if (editor.isReady === true) return true;
            if (editor.isReady === false) return false;
            // 只有 isReady 完全没定义（老版本 UE）才退回 body 判定
            return !!(editor.body && editor.body.ownerDocument && editor.body.firstChild !== undefined);
        } catch (e) { return false; }
    }

    function ueInsert(editor, text) {
        if (ueIsReady(editor)) { ueInsertNow(editor, text); return; }

        var rec = ueQueues.get(editor);
        if (rec) { rec.pending.push(text); return; }      // 已在等 ready，只入队

        rec = { pending: [text] };
        ueQueues.set(editor, rec);
        var flush = function () {
            ueQueues.delete(editor);
            var items = rec.pending;
            rec.pending = [];
            for (var i = 0; i < items.length; i++) {
                try { ueInsertNow(editor, items[i]); } catch (e) { log('queued insert failed', e); }
            }
        };
        try { editor.ready(flush); } catch (e) { ueQueues.delete(editor); ueInsertNow(editor, text); }
    }

    // 兜底：不抢原生粘贴，只在"粘完发现内容没变"时补一刀
    function bindUePaste(editor, d) {
        bindUeSelection(editor, d);
        d.addEventListener('paste', function (e) {
            var cd = e.clipboardData || w.clipboardData;
            if (!cd) return;
            if (clipboardHasFile(cd)) return;
            var text = clipboardText(cd);
            if (!text) return;
            var before = ueBodyLen(editor), beforeText = '';
            try { beforeText = editor.body ? editor.body.textContent : ''; } catch (err) {}
            setTimeout(function () {
                var nowText = '';
                try { nowText = editor.body ? editor.body.textContent : ''; } catch (err) {}
                if (ueBodyLen(editor) !== before || nowText !== beforeText) return;
                log('paste swallowed by page, inserting manually');
                ueInsert(editor, text);
                showNotice(NOTICE);
            }, 0);
        }, true);
    }

    /* ============================================================
     * CodeMirror 5
     * 不在 beforeChange 里改文档；只把站点 cancel 掉的那次 change 复活。
     * ============================================================ */
    function hookCM5(cm) {
        if (!cm || cm.__xxt5) return;
        var wrap = null;
        try { wrap = cm.getWrapperElement ? cm.getWrapperElement() : null; } catch (e) {}
        if (!wrap) return;
        cm.__xxt5 = true;

        // 捕获阶段只记录：剪贴板原文 + 当前选区快照（CM5 的选区在失焦后同样会退化）
        wrap.addEventListener('paste', function (e) {
            var cd = e.clipboardData || w.clipboardData;
            if (!cd) return;
            if (clipboardHasFile(cd)) return;
            var text = clipboardText(cd);
            if (!text) return;
            try {
                cm.__xxtPasteText = text;
                cm.__xxtPasteAt = Date.now();
                cm.__xxtFrom = cm.getCursor('from');
                cm.__xxtTo = cm.getCursor('to');
                cm.__xxtBase = cm.getValue();
            } catch (err) {}
        }, true);

        cm.on('beforeChange', function (c, change) {
            if (!change || change.origin !== 'paste') return;

            var fresh = Date.now() - (c.__xxtPasteAt || 0) < 1500;
            var stashed = fresh ? (c.__xxtPasteText || '') : '';
            var text = (change.text || []).join('\n');
            var want = stashed || text;
            if (!want) return;

            var canceled = change.canceled === true;
            var emptied = !text;

            if (canceled || (emptied && stashed)) {
                change.canceled = false;
                if (emptied && stashed && typeof change.update === 'function') {
                    change.update(undefined, undefined, stashed.split('\n'));
                }
                showNotice(NOTICE);
            } else {
                showNotice(NOTICE);
            }

            // 只有确认文档完全没变才补插；位置取粘贴瞬间的快照，
            // 不用 change.from/to（CM 可能已应用过一次，那两个位置已过期）。
            var from = c.__xxtFrom, to = c.__xxtTo;
            setTimeout(function () {
                var nowValue = null, base = c.__xxtBase;
                try { nowValue = c.getValue(); } catch (e) { return; }
                if (base === undefined || base === null) return;
                if (nowValue !== base) { c.__xxtBase = nowValue; return; }   // 已经插入
                try {
                    c.replaceRange(want, from || change.from, to || change.to, '+input');
                    c.focus();
                    try { c.__xxtBase = c.getValue(); } catch (e) {}
                    showNotice(NOTICE);
                } catch (e) { log('cm5 deferred insert failed', e); }
            }, 0);
        });
    }

    /* ============================================================
     * CodeMirror 6
     * ============================================================ */
    function viewFromCM6(host) {
        try {
            var content = (host.classList && host.classList.contains('cm-content'))
                ? host : host.querySelector('.cm-content');
            var cv = content && content.cmView;
            var v = cv && cv.rootView && (cv.rootView.view || cv.view);
            if (v && v.state && typeof v.dispatch === 'function') return v;
        } catch (e) {}
        return null;
    }

    function hookCM6(view) {
        var host = view.dom || view.contentDOM;
        if (!host || host.__xxt6) return;
        host.__xxt6 = true;
        host.addEventListener('paste', function (e) {
            var cd = e.clipboardData || w.clipboardData;
            if (!cd) return;
            if (clipboardHasFile(cd)) return;
            var text = clipboardText(cd);
            if (!text) return;
            e.preventDefault();
            e.stopImmediatePropagation();   // CM6 的 handler 挂在 contentDOM（子节点），捕获阶段先到
            try {
                var sel = view.state.selection.main;
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: text },
                    selection: { anchor: sel.from + text.length },
                    // input.type 而非 input.paste：绕开站点按 input.paste 设的 transactionFilter
                    userEvent: 'input.type',
                    scrollIntoView: true
                });
                if (typeof view.focus === 'function') view.focus();
                showNotice(NOTICE);
            } catch (err) { log('cm6 dispatch failed:', err); }
        }, true);
    }

    /* ============================================================
     * 剪贴板写入防护
     * 页面可能写入零宽字符污染剪贴板，这里只在粘贴窗口内忽略这类写入
     * ============================================================ */
    var ZERO_WIDTH = /^[\s\u200b\u200c\u200d\u2060\ufeff]*$/;
    var lastPasteAt = 0;

    function patchClipboardWrite() {
        try {
            var clip = w.navigator && w.navigator.clipboard;
            if (!clip || clip.__xxt || typeof clip.writeText !== 'function') return;
            var orig = clip.writeText.bind(clip);
            clip.writeText = function (text) {
                try {
                    if (typeof text === 'string' && ZERO_WIDTH.test(text)) {
                        // 只在"刚发生过粘贴"的 8s 窗口内拦，避免影响页面正常的空剪贴板操作
                        if (Date.now() - lastPasteAt < 8000) {
                            log('blocked pollution writeText()', JSON.stringify(text));
                            return Promise.resolve();
                        }
                    }
                } catch (e) {}
                return orig(text);
            };
            clip.__xxt = true;
        } catch (e) {}
    }

    /* ============================================================
     * 内联 on* 清理：存在才写，避免无谓的属性变更
     * ============================================================ */
    var INLINE_EVENTS = ['paste', 'copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'];

    function clearInlineHandlers(d) {
        if (!d) return;
        var targets = [d];
        if (d.body) targets.push(d.body);
        if (d.documentElement) targets.push(d.documentElement);
        for (var i = 0; i < targets.length; i++) {
            for (var j = 0; j < INLINE_EVENTS.length; j++) {
                var k = 'on' + INLINE_EVENTS[j];
                try { if (targets[i][k]) targets[i][k] = null; } catch (e) {}
            }
        }
    }

    /* ============================================================
     * 通用限制解除：右键 / 选择 / 快捷键 / CSS 禁止选中
     * 考试页的"不能粘贴"不只有 paste 事件，还有上面这几种，
     * 只拦站点自己的处理器，不碰浏览器默认行为。
     * ============================================================ */
    // 这些事件只用于"拦截站点的阻止逻辑"：捕获阶段停掉站点的监听器，
    // 但绝不调用 preventDefault，浏览器该弹的菜单、该选的字照常。
    var GUARD_EVENTS = ['paste', 'copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'];
    var guardBound = false;

    function isEditableEl(t) {
        if (!t) return false;
        if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return true;
        return t.isContentEditable === true;
    }

    function isEditorArea(t) {
        if (!t || typeof t.closest !== 'function') return false;
        if (t.closest(CM_SEL)) return true;                 // CodeMirror
        if (t.closest('.edui-editor, .edui-body-container, #edui_fixedlayer')) return true;  // UEditor
        return false;
    }

    function bindGuardEvents() {
        if (guardBound) return;
        guardBound = true;

        GUARD_EVENTS.forEach(function (type) {
            try {
                w.addEventListener(type, function (e) {
                    var t = e.target;
                    if (isEditorArea(t)) return;        // 代码编辑器自己处理
                    // 停掉站点注册在同一事件上的处理器；浏览器默认行为不受影响
                    e.stopImmediatePropagation();
                }, true);
            } catch (err) {}
        });

        // 快捷键：只处理 Ctrl/Cmd + V/X/C/A，且目标可编辑时才拦站点
        ['keydown', 'keyup'].forEach(function (type) {
            try {
                w.addEventListener(type, function (e) {
                    if (!(e.ctrlKey || e.metaKey)) return;
                    var k = String(e.key || '').toLowerCase();
                    if (k !== 'v' && k !== 'x' && k !== 'c' && k !== 'a') return;
                    if (isEditorArea(e.target)) return;
                    e.stopImmediatePropagation();
                }, true);
            } catch (err) {}
        });
    }

    function injectSelectCSS(d) {
        try {
            if (!d || d.getElementById('__xxt_unlock_css')) return;
            var st = d.createElement('style');
            st.id = '__xxt_unlock_css';
            st.textContent =
                '*{-webkit-user-select:text!important;' +
                '-moz-user-select:text!important;' +
                '-ms-user-select:text!important;' +
                'user-select:text!important;' +
                '-webkit-touch-callout:default!important;}';
            (d.head || d.documentElement).appendChild(st);
        } catch (e) {}
    }

    function unlockGeneralRestrictions() {
        bindGuardEvents();
        injectSelectCSS(doc());
        // iframe 内同样放开
        try {
            doc().querySelectorAll('iframe').forEach(function (f) {
                var d = null;
                try { d = f.contentDocument; } catch (e) { return; }
                if (!d) return;
                if (!d.__xxtGeneral) {
                    d.__xxtGeneral = true;
                    clearInlineHandlers(d);
                }
                injectSelectCSS(d);
            });
        } catch (e) {}
    }

    /* ============================================================
     * 讨论区
     * ============================================================ */
    function initDiscussion() {
        function setCfg() {
            var o = w.obj;
            if (!o) return;
            try {
                if (o.circle && typeof o.circle === 'object' && o.circle.prohibitReplyPasting !== 0) {
                    o.circle.prohibitReplyPasting = 0;
                }
                if (o.prohibitReplyPasting !== undefined && o.prohibitReplyPasting !== 0) {
                    o.prohibitReplyPasting = 0;
                }
                // 不写 o.isManager：越权会让页面弹管理按钮、服务端复核时常返 403
            } catch (e) {}
        }
        // 时间戳用于剪贴板污染防护的时间窗；粘贴拦截统一由 bindGuardEvents 负责，
        // 这里只做记录，避免同一个事件挂两个捕获监听造成行为叠加。
        w.addEventListener('paste', function () { lastPasteAt = Date.now(); }, true);
        return setCfg;
    }

    /* ============================================================
     * 扫描
     * ============================================================ */
    function scanUEditor() {
        var UE = w.UE;
        if (!UE || !UE.instants) return 0;
        wrapAddListener(UE.Editor && UE.Editor.prototype);
        var n = 0, keys;
        try { keys = Object.keys(UE.instants); } catch (e) { return 0; }
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            try {
                var editor = UE.instants[key];
                if (!editor) continue;
                guardEditor(editor);
                enablePasteFile(editor);
                var d = null;
                try { d = editor.iframe && editor.iframe.contentDocument; } catch (e) { d = null; }
                if (!d) continue;
                if (!d.__xxtPasteHooked) {
                    d.__xxtPasteHooked = true;
                    bindUePaste(editor, d);
                    clearInlineHandlers(d);
                    log('UEditor paste unlocked:', key);
                }
                n++;
            } catch (e) { log('ue scan error:', key, e); }
        }
        return n;
    }

    function scanCM(root) {
        if (!root || !root.querySelectorAll) return 0;
        var n = 0;
        try {
            root.querySelectorAll('.CodeMirror').forEach(function (wrap) {
                if (wrap.CodeMirror) { hookCM5(wrap.CodeMirror); n++; }
            });
            root.querySelectorAll('.cm-editor, .cm-content').forEach(function (host) {
                var v = viewFromCM6(host);
                if (v) { hookCM6(v); n++; }
            });
        } catch (e) { log('scanCM error', e); }
        return n;
    }

    function scanAll() {
        var n = 0;
        try { n += scanUEditor(); } catch (e) { log('ue scan failed', e); }
        n += scanCM(doc());
        try {
            doc().querySelectorAll('iframe').forEach(function (f) {
                var d = null;
                try { d = f.contentDocument; } catch (e) { return; }
                if (d) n += scanCM(d);
            });
        } catch (e) {}
        var ce = w.codeEditors;
        if (ce && typeof ce === 'object') {
            for (var id in ce) {
                var ed = ce[id];
                if (ed && typeof ed.on === 'function') { hookCM5(ed); n++; }
            }
        }
        return n;
    }

    /* ============================================================
     * 单 ticker
     * ============================================================ */
    var timer = null, dirty = true, lastHit = 0, lastScan = 0, setCfg = null;

    function tick() {
        var d = doc();
        if (!d || d.hidden) return;
        patchUeConfig();
        var now = Date.now();
        var idle = now - lastHit > 3000 ? 2500 : 600;
        if (!dirty && now - lastScan < idle) return;
        dirty = false;
        lastScan = now;
        try {
            if (scanAll() > 0) lastHit = now;
            unlockGeneralRestrictions();
            if (setCfg) setCfg();
        } catch (e) { log('tick error:', e); }
    }

    function startTimer() { if (!timer) timer = setInterval(tick, 600); }

    /* ---- 立即安装 ----
     * 超星自家域名：document-start 就装，赶在页面脚本赋值前拿到 editorPaste
     * 其它域名（学校定制版）：等 DOM 就绪、确认是学习通再装，避免污染无关站点
     */
    function installEarlyHooks() {
        try {
            applyEditorPaste(w.editorPaste);
            Object.defineProperty(w, 'editorPaste', {
                configurable: true, enumerable: true,
                get: function () { return editorPasteRef; },
                set: applyEditorPaste
            });
        } catch (e) {
            try { w.editorPaste = passthrough; } catch (e2) {}
        }

        patchUeConfig();
        patchClipboardWrite();
        injectSelectCSS(doc());     // 尽早放开选择；文档未就绪时 boot 会再试一次

        try {
            var ueRef = w.UE;
            Object.defineProperty(w, 'UE', {
                configurable: true, enumerable: true,
                get: function () { return ueRef; },
                set: function (v) { ueRef = v; dirty = true; }
            });
        } catch (e) {}
    }

    var EARLY = isChaoxingHost();
    if (EARLY) installEarlyHooks();

    /* ---- 启动 ---- */
    function boot() {
        var d = doc();

        // 非学习通页面（学校定制域名下的其它系统）不介入
        if (!EARLY && !detectChaoxingPage()) {
            log('not a chaoxing page, skip');
            try { delete w.__xxtPasteUnlock; } catch (e) { w.__xxtPasteUnlock = false; }
            return;
        }
        if (!EARLY) { installEarlyHooks(); EARLY = true; }

        setCfg = initDiscussion();
        clearInlineHandlers(d);
        unlockGeneralRestrictions();

        try {
            new MutationObserver(function () { dirty = true; })
                .observe(d.documentElement || d, { childList: true, subtree: true });
        } catch (e) {}

        d.addEventListener('visibilitychange', function () {
            if (d.hidden) { clearInterval(timer); timer = null; }
            else { startTimer(); tick(); }
        });

        startTimer();
        tick();
    }

    if (doc().readyState === 'loading') {
        doc().addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
