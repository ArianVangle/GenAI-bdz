// Автоиспытания игры «Капля» в Chromium без интерфейса.
// Запуск из корня репозитория
//   npm install playwright
//   npx playwright install chromium
//   node tests/run.js
// Файлы игры берутся из папки game и не меняются. В копию game.js в памяти
// добавляется одна строка, которая открывает объект игры для сценария.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GAME = path.join(__dirname, '..', 'game');
const ORIGIN = 'http://kaplya.test/';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  await page.route(ORIGIN + '**', route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    const file = path.join(GAME, path.basename(name));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(file, 'utf8');
    if (name === 'game.js') {
      const hook = "const game=new Game(document.getElementById('game'));";
      if (!body.includes(hook)) throw new Error('В game.js не найдена строка создания игры');
      body = body.replace(hook, hook + 'window.game=game;');
    }
    route.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body });
  });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(ORIGIN + 'index.html');
  await page.waitForFunction(() => window.game);
  const loadMs = Date.now() - t0;

  await page.evaluate(() => {
    window.runLevel = (ch, idx, strategy, limit = 200) => {
      const g = window.game, inp = g.input;
      if (ch === 1) g.start(idx); else g.startBus(idx);
      inp.keys.clear(); inp.pressed.clear(); inp.down = false;
      const dt = 1 / 60;
      let nextChange = 0, axis = 0, hold = false, viol = [], maxStep = 0;
      for (let step = 0; step < limit * 60; step++) {
        const L = g.level, p = L.player, t = L.t;
        if (strategy === 'random') {
          if (t >= nextChange) {
            axis = [-1, 0, 1][Math.floor(Math.random() * 3)];
            hold = Math.random() < 0.2;
            nextChange = t + 0.3 + Math.random() * 0.7;
          }
          inp.down = axis !== 0; inp.pointer = p.x + axis * 100;
        } else {
          const r = window.bots[strategy](L, p, t);
          inp.down = r.x !== undefined; inp.pointer = r.x;
          hold = !!r.hold;
        }
        if (hold) inp.keys.add('arrowdown'); else inp.keys.delete('arrowdown');
        const ox = p.x, oy = p.y;
        g.update(dt);
        inp.endFrame();
        if (g.state !== 'play') {
          return { result: g.state, reason: g.state === 'fail' ? g.error : '', t: +L.t.toFixed(1), r: +p.r.toFixed(2), stars: g.stars || 0, viol, maxStep: +maxStep.toFixed(1) };
        }
        maxStep = Math.max(maxStep, Math.hypot(p.x - ox, p.y - oy));
        if (![p.x, p.y, p.r].every(Number.isFinite)) viol.push('nan@' + t.toFixed(2));
        if (p.x < 40 + p.r - 0.5 || p.x > 920 - p.r + 0.5 || p.y < 30 + p.r - 0.5 || p.y > 540 - p.r + 0.5) viol.push('out@' + t.toFixed(2));
        for (const o of L.obstacles) if (Math.abs(p.x - o.x) < o.rx + p.r - 0.5 && Math.abs(p.y - o.y) < o.ry + p.r - 0.5) viol.push('inobst@' + t.toFixed(2));
        for (const d of L.rain) if (![d.x, d.y, d.r].every(Number.isFinite)) viol.push('rainnan');
        if (viol.length > 5) break;
      }
      return { result: 'timeout', viol };
    };
    const exitX = L => { const e = L.d.exit; return e[0] === 'left' ? 0 : e[0] === 'right' ? 960 : (e[1] + e[2]) / 2; };
    window.bots = {
      toExit: L => ({ x: exitX(L) }),
      busFree: L => ({ x: exitX(L) }),
      busHold: L => ({ x: exitX(L), hold: !L.isRequiredStop() }),
      busHoldMid: (L, p) => {
        const e = L.d.exit, mid = (e[1] + e[2]) / 2, stop = L.isRequiredStop();
        return { x: exitX(L), hold: !stop ? p.y > mid - 20 : p.y > e[2] - 10 };
      },
    };
  });

  const levels = [[1, 0, 'Парковка'], [1, 1, 'Трасса'], [1, 2, 'Ночь'], [2, 0, 'Цветочная'], [2, 1, 'Пробка'], [2, 2, 'Парк']];
  const report = { date: new Date().toISOString(), loadMs, levels: [] };
  const N = 30, NB = 20;
  const sum = arr => { const o = {}; for (const r of arr) { const k = r.result + (r.reason ? ' (' + r.reason + ')' : ''); o[k] = (o[k] || 0) + 1; } return o; };
  for (const [ch, idx, name] of levels) {
    const rnd = [];
    for (let k = 0; k < N; k++) rnd.push(await page.evaluate(([c, i]) => runLevel(c, i, 'random'), [ch, idx]));
    const botNames = ch === 1 ? ['toExit'] : ['busFree', 'busHold', 'busHoldMid'];
    const bots = {};
    for (const b of botNames) {
      bots[b] = [];
      for (let k = 0; k < NB; k++) bots[b].push(await page.evaluate(([c, i, b]) => runLevel(c, i, b), [ch, idx, b]));
    }
    report.levels.push({ name, ch, idx, rnd, bots });
    console.log(name, '| случайная игра', JSON.stringify(sum(rnd)), '| нарушений', rnd.reduce((a, r) => a + r.viol.length, 0));
    for (const b of botNames) console.log('   бот', b, JSON.stringify(sum(bots[b])));
  }
  report.perf = await page.evaluate(() => {
    const g = window.game, out = {};
    for (const [c, i] of [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]) {
      if (c === 1) g.start(i); else g.startBus(i);
      const t0 = performance.now();
      for (let k = 0; k < 300; k++) { g.update(1 / 60); g.input.endFrame(); g.renderer.draw(g); }
      out[g.level.d.name] = +((performance.now() - t0) / 300).toFixed(2);
    }
    return out;
  });
  report.errors = errors;
  console.log('мс на кадр', JSON.stringify(report.perf), '| загрузка', loadMs, 'мс | ошибок в консоли', errors.length);
  fs.writeFileSync(path.join(__dirname, 'report_latest.json'), JSON.stringify(report, null, 1));
  await browser.close();
})();
