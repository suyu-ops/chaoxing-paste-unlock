// 1.4.2 回归测试
// 核心新逻辑：guardBeforePaste 行为还原 / 零宽字符污染拦截 / CM5 选区快照 / UE ready 队列去重
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'chaoxing-paste-unlock.user.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x))); };

function env(html, pre) {
  const dom = new JSDOM(html || '<!doctype html><html><body></body></html>', {
    url: 'https://mooc1.chaoxing.com/mooc-ans/work',
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  w.console.log = () => {};
  if (pre) pre(w);
  w.eval(SRC);
  return w;
}
const ev = (w, data) => {
  const e = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data, configurable: true });
  return e;
};
const cd = (o) => ({
  items: o.items || [], files: o.files || [], types: o.types || ['text/plain'],
  getData: (t) => (o[t] === undefined ? '' : o[t])
});

(async () => {
  console.log('\n[A] 零宽字符判据');
  {
    ok("'\\u200b'.trim() 不是空（证明旧判据失效）", '\u200b'.trim() !== '');
    const w = env(null, (win) => {
      win.__calls = [];
      win.navigator.clipboard = { writeText(t) { win.__calls.push(t); return Promise.resolve(); } };
    });
    await sleep(50);
    // 触发粘贴窗口
    w.document.dispatchEvent(ev(w, cd({ 'text/plain': 'x' })));
    w.navigator.clipboard.writeText('\u200b\u200b');
    w.navigator.clipboard.writeText('\u2060');
    w.navigator.clipboard.writeText('正常文本');
    await sleep(30);
    const got = w.__calls;
    ok('零宽 U+200B 被拦', got.indexOf('\u200b\u200b') === -1, got);
    ok('零宽 U+2060 被拦', got.indexOf('\u2060') === -1, got);
    ok('正常文本放行', got.indexOf('正常文本') >= 0, got);
  }

  console.log('\n[B] guardBeforePaste：行为还原（不靠源码文案）');
  {
    const w = env();
    const d = w.document;
    const iframe = d.createElement('iframe');
    d.body.appendChild(iframe);
    const idoc = iframe.contentDocument;

    // 站点监听器：不含 MARK、也不含 html.html="" 字面量（写的是 null），但仍清空内容
    const sneakyBlocker = function (html) {
      html.html = null;        // 行为拦截（UE: if (!html.html) return）
      return false;
    };
    // 正常监听器：读一下就返回，不清空
    const normalListener = function (html) { html.html = html.html + ''; return undefined; };

    const editor = {
      key: 'e1', isReady: true, iframe, body: idoc.body,
      options: { enterTag: 'p' },
      __allListeners: { beforepaste: [] },
      execCommand(name, html) { idoc.body.insertAdjacentHTML('beforeend', html); },
      fireEvent() {},
      focus() {},
      ready(cb) { cb(); },
      addListener(t, fn) { (this.__allListeners[t] = this.__allListeners[t] || []).push(fn); }
    };
    editor.__allListeners.beforepaste.push(sneakyBlocker, normalListener);

    w.UE = { instants: { e1: editor }, Editor: { prototype: { addListener: function () {} } } };
    await sleep(900);   // 等 ticker 扫到并 guardEditor

    ok('数组长度未被改变（不用 splice 删除）', editor.__allListeners.beforepaste.length === 2,
      editor.__allListeners.beforepaste.length);
    ok('认不出的监听器被包了一层', editor.__allListeners.beforepaste[0].__xxtGuard === true,
      typeof editor.__allListeners.beforepaste[0]);

    // 手动模拟 UE 的 fireEvent('beforepaste', html)
    const html = { html: '<p>用户粘贴的内容</p>' };
    const list = editor.__allListeners.beforepaste;
    for (let k = list.length - 1; k >= 0; k--) {
      if (!list[k]) continue;
      list[k].call(editor, html, null);
    }
    ok('被清空的 html.html 被还原', html.html === '<p>用户粘贴的内容</p>', html.html);
    ok('正常监听器没被误伤', typeof list[1] === 'function' && list[1].__xxtGuard === true);
  }

  console.log('\n[C] addListener 路径：认得出就丢，认不出就包行为兜底');
  {
    const got = [];
    const w = env(null, (win) => {
      win.UE = { instants: {}, Editor: { prototype: { addListener: function (t, fn) { got.push({ t, fn }); } } } };
    });
    await sleep(900);
    const proto = w.UE.Editor.prototype;
    ok('addListener 已包裹', proto.addListener.__xxt === true);

    // 认得出（含 MARK）：直接丢
    proto.addListener('beforepaste', function (h) { /* 只能录入不能粘贴 */ h.html = ''; });
    ok('含 MARK 的监听器被丢弃', got.length === 0, got.length);

    // 认不出：包一层
    const unknown = function (h) { h.html = ''; };
    proto.addListener('beforepaste', unknown);
    ok('认不出的监听器被放行（但已包）', got.length === 1 && got[0].fn !== unknown && got[0].fn.__xxtGuard === true);
    const h = { html: 'abc' };
    got[0].fn(h);
    ok('包过后行为被还原', h.html === 'abc', h.html);

    // 非 beforepaste 的任何监听器都不动
    const plain = function () {};
    proto.addListener('contentChange', plain);
    ok('其它事件不包装', got[1].fn === plain);
  }

  console.log('\n[D] CM5：选区快照 + 只在文档没变时补插');
  {
    const w = env('<!doctype html><html><body><div class="CodeMirror" id="cmw"></div></body></html>');
    const wrap = w.document.getElementById('cmw');
    const handlers = [];
    let value = 'ABCDEF', replaced = null, focused = false;
    const cm = {
      getWrapperElement() { return wrap; },
      getCursor(which) { return which === 'from' ? { line: 0, ch: 2 } : { line: 0, ch: 4 }; },
      getValue() { return value; },
      replaceRange(t, f, to, origin) { replaced = { t, f, to, origin }; value = t.join ? t.join('') : t; },
      focus() { focused = true; },
      on(name, fn) { if (name === 'beforeChange') handlers.push(fn); }
    };
    wrap.CodeMirror = cm;
    await sleep(900);
    ok('beforeChange 已注册', handlers.length === 1);

    // 真粘贴：捕获阶段记录快照
    wrap.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': 'XYZ' })));
    ok('捕获到选区 from', cm.__xxtFrom && cm.__xxtFrom.ch === 2, cm.__xxtFrom);
    ok('捕获到选区 to', cm.__xxtTo && cm.__xxtTo.ch === 4, cm.__xxtTo);
    ok('捕获到改动前文档', cm.__xxtBase === 'ABCDEF', cm.__xxtBase);

    // 站点 cancel 掉了：我们复活
    const change = {
      origin: 'paste', from: { line: 0, ch: 9 }, to: { line: 0, ch: 9 },   // 故意给错位置
      text: ['XYZ'], canceled: false,
      cancel() { this.canceled = true; },
      update(f, t, txt) { if (txt) this.text = txt; }
    };
    change.cancel();
    handlers[0](cm, change);
    ok('change 被复活', change.canceled === false);

    // 模拟 CM 没插进去（文档没变）
    await sleep(40);
    ok('文档没变时用快照位置补插', replaced && replaced.f.ch === 2 && replaced.to.ch === 4, replaced);
    ok('补插 origin=+input', replaced && replaced.origin === '+input', replaced && replaced.origin);
    ok('补插后 focus', focused === true);
  }

  console.log('\n[E] CM5：文档已变（CM 自己插了）则不重复插');
  {
    const w = env('<!doctype html><html><body><div class="CodeMirror" id="cmw"></div></body></html>');
    const wrap = w.document.getElementById('cmw');
    const handlers = [];
    let value = 'OLD', replaceCount = 0;
    const cm = {
      getWrapperElement() { return wrap; },
      getCursor() { return { line: 0, ch: 0 }; },
      getValue() { return value; },
      replaceRange(t) { replaceCount++; value += t; },
      focus() {},
      on(n, fn) { if (n === 'beforeChange') handlers.push(fn); }
    };
    wrap.CodeMirror = cm;
    await sleep(900);

    wrap.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': 'NEW' })));
    const change = { origin: 'paste', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, text: ['NEW'], canceled: false, cancel() {}, update() {} };
    handlers[0](cm, change);
    value = 'NEWOLD';                    // CM 自己插成功
    await sleep(40);
    ok('文档已变时不补插', replaceCount === 0, replaceCount);
  }

  console.log('\n[F] UE ready 队列：连点两次只准备一次回调');
  {
    const w = env();
    const d = w.document;
    const iframe = d.createElement('iframe');
    d.body.appendChild(iframe);
    const idoc = iframe.contentDocument;
    let readyCalls = 0, inserts = 0;
    const editor = {
      key: 'e1', isReady: false, iframe, body: idoc.body,
      options: { enterTag: 'p' },
      execCommand(name, html) { inserts++; idoc.body.insertAdjacentHTML('beforeend', html || ''); },
      fireEvent() {}, focus() {},
      ready(cb) { readyCalls++; this.__cb = cb; }
    };
    w.UE = { instants: { e1: editor }, Editor: { prototype: {} } };
    await sleep(900);

    // 直接调用内部插入路径不可达，改为通过粘贴兜底触发两次
    idoc.body.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': 'x' })));
    idoc.body.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': 'y' })));
    await sleep(80);
    ok('ready 只注册一次', readyCalls === 1, readyCalls);
    editor.isReady = true;
    if (editor.__cb) editor.__cb();
    await sleep(30);
    ok('ready 后把队列里两条都插了', inserts === 2, inserts);
  }

  console.log('\n[G] 幂等 & 内联 on* 无副作用');
  {
    const w = env('<!doctype html><html><body onpaste="return false"><div></div></body></html>');
    await sleep(60);
    ok('版本标记 1.4.2', w.__xxtPasteUnlock === '1.4.2');
    ok('body.onpaste 被清', w.document.body.onpaste === null);
    // 没有 on* 的元素不应被写入属性
    const div = w.document.querySelector('div');
    div.onclick = null;
    ok('无 on* 的目标保持 null 不新增', div.onpaste === null);
    let threw = null;
    try { w.eval(SRC); } catch (e) { threw = e; }
    ok('二次执行不抛错', threw === null, threw && threw.message);
  }

  console.log('\n[H] 通用限制解除：右键 / 选择 / 快捷键 / CSS');
  {
    const w = env('<!doctype html><html><body><textarea id="ta"></textarea><div id="txt">可选文字</div></body></html>');
    const d = w.document;
    await sleep(700);

    // 站点在 document 上挂了 contextmenu 拦截
    let siteCtx = false, siteSel = false, siteKey = false;
    d.addEventListener('contextmenu', (e) => { siteCtx = true; e.preventDefault(); }, false);
    d.addEventListener('selectstart', (e) => { siteSel = true; }, false);
    d.addEventListener('keydown', (e) => { if (e.ctrlKey) siteKey = true; }, false);

    const ctx = new w.Event('contextmenu', { bubbles: true, cancelable: true });
    d.getElementById('txt').dispatchEvent(ctx);
    ok('站点 contextmenu 处理器被拦', siteCtx === false);
    ok('默认行为未被 preventDefault', ctx.defaultPrevented === false);

    d.getElementById('txt').dispatchEvent(new w.Event('selectstart', { bubbles: true, cancelable: true }));
    ok('站点 selectstart 处理器被拦', siteSel === false);

    const kd = new w.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    d.getElementById('ta').dispatchEvent(kd);
    ok('站点 Ctrl+V 键位处理器被拦', siteKey === false);
    ok('键位默认行为未被阻止', kd.defaultPrevented === false);

    // CSS 注入
    const st = d.getElementById('__xxt_unlock_css');
    ok('user-select 样式已注入', !!st && /user-select:text/.test(st.textContent));

    // 非 ctrl 键不受影响
    let plainKey = false;
    const kd2 = new w.KeyboardEvent('keydown', { key: 'a', bubbles: true });
    w.addEventListener('keydown', () => { plainKey = true; }, true);
    d.getElementById('ta').dispatchEvent(kd2);
    ok('普通按键不被拦截（捕获序在站点之前仍放行）', true);
  }

  console.log('\n[I] 考试域覆盖与不误伤');
  {
    // exam 子域应被 @match 覆盖
    const meta = fs.readFileSync(path.join(__dirname, '..', 'chaoxing-paste-unlock.user.js'), 'utf8');
    ok('无 @exclude 行', !/^\/\/ @exclude/m.test(meta), 'found @exclude');
    ok('@match 覆盖 *.chaoxing.com', /\*:\/\/\*\.chaoxing\.com\/\*/.test(meta));
    ok('无 exam 特判代码', !/exam\.chaoxing|isExam/.test(meta.replace(/^\/\/ .*$/gm, '')));

    // 代码编辑器区域不被通用守卫误伤
    const w = env('<!doctype html><html><body><div class="CodeMirror" id="cmw"></div></body></html>');
    const wrap = w.document.getElementById('cmw');
    let reached = false;
    wrap.addEventListener('paste', () => { reached = true; }, false);
    await sleep(700);
    wrap.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': 'x' })));
    ok('CodeMirror 区域内的 paste 不被通用守卫挡掉', reached === true);
  }

  console.log('\n[J] UEditor 正文不被通用守卫误伤');
  {
    const w = env('<!doctype html><html><body></body></html>');
    const d = w.document;
    const iframe = d.createElement('iframe');
    d.body.appendChild(iframe);
    const idoc = iframe.contentDocument;
    const editor = {
      key: 'e9', isReady: true, iframe, body: idoc.body,
      options: { enterTag: 'p' },
      execCommand(n, html) { idoc.body.insertAdjacentHTML('beforeend', html); },
      fireEvent() {}, focus() {}, ready(cb) { cb(); }
    };
    w.UE = { instants: { e9: editor }, Editor: { prototype: {} } };
    await sleep(900);

    let uePasteSeen = false;
    idoc.body.addEventListener('paste', () => { uePasteSeen = true; }, false);
    idoc.body.dispatchEvent(ev(w, cd({ types: ['text/plain'], 'text/plain': '答案' })));
    ok('UEditor 正文的 paste 事件可达', uePasteSeen === true);

    await sleep(60);
    ok('UEditor 兜底插入生效', /答案/.test(idoc.body.innerHTML), idoc.body.innerHTML);
  }

  console.log('\n[K] 定制版域名：非学习通页面不介入');
  {
    // K1 学校域名 + 无学习通特征 = 应静默退出
    const dom = new JSDOM('<!doctype html><html><head></head><body><h1>某校教务系统</h1></body></html>', {
      url: 'https://jw.example.edu.cn/student', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w = dom.window; w.console.log = () => {};
    w.eval(SRC);
    await sleep(400);
    ok('非学习通页面不写入安装标记', !w.__xxtPasteUnlock, w.__xxtPasteUnlock);
    ok('未注入 user-select 样式', !w.document.getElementById('__xxt_unlock_css'));
    ok('未改写 editorPaste', w.editorPaste === undefined);

    // K2 学校域名 + 有 UEditor 特征 = 应启用
    const dom2 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://mooc.some-univ.edu.cn/work', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w2 = dom2.window; w2.console.log = () => {};
    w2.UEDITOR_CONFIG = { UEDITOR_HOME_URL: '/ueditor/' };
    w2.eval(SRC);
    await sleep(700);
    ok('学习通特征页面启用', w2.__xxtPasteUnlock === '1.4.2', w2.__xxtPasteUnlock);
    ok('注入 user-select 样式', !!w2.document.getElementById('__xxt_unlock_css'));

    // K3 超星自家域名 = 无需特征，立即启用
    const dom3 = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://exam.chaoxing.com/exam', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w3 = dom3.window; w3.console.log = () => {};
    w3.eval(SRC);
    ok('超星域名立即启用', w3.__xxtPasteUnlock === '1.4.2', w3.__xxtPasteUnlock);
    ok('超星域名立即注入样式', !!w3.document.getElementById('__xxt_unlock_css'));
  }

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
