/*!
 * ascii-life — живые ASCII-сцены на сетке плиток с глифами.
 * Один файл, без зависимостей, ES5 + Canvas 2D (рассчитан на Chromium M85 / Tizen 6.5).
 *
 * Использование:
 *   var life = new AsciiLife(containerOrCanvas, { scene: 'koi' });
 *   life.start();
 *   life.set({ scene: 'butterfly', palette: 'rose', count: 9 });
 *   life.tap(clientX, clientY);   // действие сцены в точке (корм, испуг, всплеск)
 *   life.destroy();
 *
 * Кадр собирается слоями:
 *   1. Маска: сцена рисует существ векторными путями в холст, где 1 пиксель = 1 клетка.
 *      Альфа пикселя — покрытие клетки, RGB — её цвет.
 *   2. Карта владельцев: какому существу принадлежит клетка. По ней символы и фактура
 *      привязываются к телу (едут вместе с ним), а дальние существа тают в фон.
 *   3. След: в водных сценах — симуляция волн (их поднимают существа, клики и курсор),
 *      в воздушных — рассеивающаяся дымка.
 *   4. Световой слой: пруд рисуется шейдером WebGL (дно, преломление, каустика, тени, искры),
 *      дымка — свечением в разрешении сетки. Без WebGL пруд не рисуется, фон остаётся тёмным.
 *   5. Клетки: плитка + символ тёмным оттенком её цвета; неполные клетки — только символ.
 *   6. Пост-обработка: блум и размытие через уменьшенную копию кадра.
 *
 * Новое существо = запись в AsciiLife.scenes с методами spawn / update / draw (и tap по желанию).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AsciiLife = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;
  var PI = Math.PI;

  var DEFAULTS = {
    scene: 'butterfly',
    palette: null,        // имя палитры сцены; null = палитра сцены по умолчанию
    count: null,          // число существ; null = значение сцены
    cols: 150,            // плотность сетки: клеток по ширине (если cell = 0)
    cell: 0,              // размер клетки в CSS px; 0 = считать от cols
    fps: 30,
    maxDpr: 1.5,          // потолок devicePixelRatio (на ТВ ставить 1)
    size: 1,
    speed: 1,
    farDepth: 0.3,        // масштаб самых дальних существ (не ниже minDepth сцены)
    farBias: 1.2,         // > 1 — больше существ вдали
    fog: 0.6,             // 0..1 насколько дальние существа тают в фон
    separation: 1,        // 0..2 как сильно соседи держат дистанцию
    trail: 0.18,          // 0..1 след: как долго живут волны на воде / дымка
    tileGlyphs: 0.7,      // 0..1 доля плиток с символом внутри; 0 = чистые квадраты
    glyphTone: 0.4,       // 0..1 насколько символ темнее своей плитки
    fx: true,             // световой слой: вода с каустикой либо дымка следа
    waterLight: 1,        // 0..2 яркость света на дне пруда
    waterMood: null,      // свет на воде: 'leaves' | 'clouds' | 'sun' | 'moon'; null = вариант сцены
    waterScale: 1,        // разрешение слоя воды относительно холста (на ТВ можно 0.5)
    bloom: 0.2,           // 0..1.5 свечение ярких областей
    blur: 0,              // 0..1 мягкость картинки
    grid: true,
    gridColor: 'rgba(255,255,255,0.035)',
    background: '#06070a', // или 'transparent' для наложения поверх интерфейса
    glow: true,           // пятно света вокруг курсора
    pointer: 'flee',      // реакция на наведение: 'flee' | 'attract' | 'none'
    tapAction: null,      // что делает клик: имя из scene.taps, 'splash', 'none'; null = действие сцены по умолчанию
    seed: 1,
    glyphs: ' .:;/=+*%#@'
  };

  /* ---------- утилиты ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y, s) {
    var h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function turnTo(a, target, maxStep) {
    var d = Math.atan2(Math.sin(target - a), Math.cos(target - a));
    if (d > maxStep) d = maxStep; else if (d < -maxStep) d = -maxStep;
    return a + d;
  }

  function hexRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }

  function makeAtlas(glyphs, cell, color) {
    var cv = document.createElement('canvas');
    cv.width = cell * glyphs.length;
    cv.height = cell;
    var g = cv.getContext('2d');
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold ' + Math.max(5, Math.round(cell * 0.86)) +
      'px Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono","Courier New",monospace';
    for (var i = 0; i < glyphs.length; i++) {
      g.fillText(glyphs.charAt(i), i * cell + cell / 2, cell / 2 + cell * 0.04);
    }
    return cv;
  }

  /* ---------- помощники сцен ---------- */

  function countOf(e, def) {
    var n = e.o.count;
    return (n === null || n === undefined) ? def : n;
  }

  function baseSpawn(e, n, fn) {
    var items = [], i, c;
    for (i = 0; i < n; i++) {
      c = {
        x: e.rnd() * e.cols, y: e.rnd() * e.rows, a: e.rnd() * TAU,
        z: Math.pow(e.rnd(), e.o.farBias), s: 1,
        o1: e.rnd() * TAU, o2: e.rnd() * TAU, ph: e.rnd() * TAU,
        boost: 0, w: 0, vx: 0, vy: 0, gl: 0, go: 0, fl: 0, fa: 0, fk: 0, glow: 0
      };
      if (fn) fn(c, i);
      items.push(c);
    }
    items.sort(function (p, q) { return p.z - q.z; });
    return items;
  }

  // Масштаб существа в клетках на единицу его рисунка. Движок кладёт результат в c.s каждый кадр.
  function depthScale(e, c) {
    var s = e.scene, fd = Math.max(e.o.farDepth, s.minDepth || 0);
    return e.unit * e.o.size * (s.scale || 1) * (fd + (1 - fd) * c.z);
  }

  // Расстояние r (в единицах существа) в клетках — для полей за краем экрана.
  function ext(e, r) { return r * e.unit * e.o.size * (e.scene.scale || 1); }

  // Перенос через край. Возвращает true, если существо телепортировалось.
  function wrap(e, c, m) {
    var x = c.x, y = c.y;
    if (c.x < -m) c.x = e.cols + m; else if (c.x > e.cols + m) c.x = -m;
    if (c.y < -m) c.y = e.rows + m; else if (c.y > e.rows + m) c.y = -m;
    return x !== c.x || y !== c.y;
  }

  // Близость курсора 0..1; в e._pa кладёт угол, куда существу стоит повернуть.
  function near(e, c, radius) {
    var P = e.pointer;
    if (e.o.pointer === 'none' || P.power < 0.15) return 0;
    var dx = c.x - P.x, dy = c.y - P.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d >= radius) return 0;
    e._pa = Math.atan2(dy, dx) + (e.o.pointer === 'attract' ? PI : 0);
    return 1 - d / radius;
  }

  // Поворот с инерцией: существо набирает угловую скорость c.w, а не разворачивается мгновенно.
  // Пока c.fl > 0, существо держит курс c.fa с силой c.fk (испуг от клика, путь к корму).
  function steer(e, c, dt, radius, wander, maxW, resp) {
    var k, wd, d;
    if (c.fl > 0) { c.fl -= dt; k = c.fk; e._pa = c.fa; }
    else k = near(e, c, radius);
    if (k > 0) {
      d = Math.atan2(Math.sin(e._pa - c.a), Math.cos(e._pa - c.a));
      wd = d * 4 * (0.4 + k);
      if (wd > maxW) wd = maxW; else if (wd < -maxW) wd = -maxW;
      if (k > c.boost) c.boost = k;
    } else {
      wd = wander;
    }
    c.w += (wd - c.w) * Math.min(1, dt * resp);
    c.a += c.w * dt;
    return k;
  }

  // Соседи на близкой глубине расталкиваются и слегка отворачивают друг от друга.
  function separate(e, c, dt, r, push) {
    var it = e.items, k = e.o.separation, i, o, dx, dy, d, rr, f, ax = 0, ay = 0;
    if (k <= 0) return;
    for (i = 0; i < it.length; i++) {
      o = it[i];
      if (o === c || Math.abs(o.z - c.z) > 0.3) continue;
      dx = c.x - o.x; dy = c.y - o.y;
      d = Math.sqrt(dx * dx + dy * dy);
      rr = (c.s + o.s) * r;
      if (d < rr && d > 0.001) { f = 1 - d / rr; ax += dx / d * f; ay += dy / d * f; }
    }
    if (ax || ay) {
      c.x += ax * push * k * dt;
      c.y += ay * push * k * dt;
      c.a = turnTo(c.a, Math.atan2(ay, ax), dt * 1.2 * k * Math.min(1, Math.sqrt(ax * ax + ay * ay)));
    }
  }

  // Испуг: вызывает fn(c, уголПрочь, близость) для существ в радиусе от точки.
  function scare(e, x, y, radius, fn) {
    var it = e.items, i, c, dx, dy, d;
    for (i = 0; i < it.length; i++) {
      c = it[i];
      dx = c.x - x; dy = c.y - y;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d < radius) fn(c, Math.atan2(dy, dx), 1 - d / radius);
    }
  }

  // След: существо возмущает поле (волна на воде или дымка в воздухе). Не зависит от fps.
  function shed(e, x, y, amt, dt) { e.disturb(x, y, amt * e.o.trail * dt * 60); }

  function splash(e, x, y, amt) {
    if (e.scene.water) { e.disturb(x, y, amt); return; }
    e.disturb(x, y, amt);
    e.disturb(x + 1, y, amt * 0.5);
    e.disturb(x - 1, y, amt * 0.5);
    e.disturb(x, y + 1, amt * 0.5);
    e.disturb(x, y - 1, amt * 0.5);
  }

  // Плавник-веер: корень в (rx, ry), направление ang, длина len, ширина wid (знак задаёт сторону выпуклости).
  function fan(g, rx, ry, ang, len, wid) {
    var dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
    g.beginPath();
    g.moveTo(rx, ry);
    g.quadraticCurveTo(rx + dx * len * 0.45 + px * wid, ry + dy * len * 0.45 + py * wid,
      rx + dx * len + px * wid * 0.3, ry + dy * len + py * wid * 0.3);
    g.quadraticCurveTo(rx + dx * len * 0.85 - px * wid * 0.9, ry + dy * len * 0.85 - py * wid * 0.9,
      rx + dx * len * 0.25 - px * wid * 0.55, ry + dy * len * 0.25 - py * wid * 0.55);
    g.closePath();
    g.fill();
  }

  function place(g, x, y, a, s) {
    var c = Math.cos(a) * s, n = Math.sin(a) * s;
    g.setTransform(c, n, -n, c, x, y);
  }

  function ell(g, x, y, rx, ry, rot) {
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot || 0, 0, TAU);
    g.fill();
  }

  function dot(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  /* ---------- сцены ---------- */

  var scenes = {};

  /* Бабочки: вид сверху, взмах = сжатие крыльев по поперечной оси.
     Крыло = тёмная кайма + основной тон + светлое поле + пятна на кайме. */
  function butterflyWings(g) {
    g.beginPath();
    g.moveTo(0.7, 0.15);
    g.bezierCurveTo(3.8, 0.6, 4.6, 5.6, 1.6, 6.4);
    g.bezierCurveTo(0.2, 6.0, -0.3, 2.4, 0.1, 0.15);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(-0.1, 0.15);
    g.bezierCurveTo(-0.3, 2.6, -1.0, 4.9, -2.9, 4.7);
    g.bezierCurveTo(-4.4, 3.9, -3.4, 0.9, -0.9, 0.15);
    g.closePath();
    g.fill();
  }

  scenes.butterfly = {
    label: 'Butterfly', dot: '#3b9bff', count: 11, palette: 'azure',
    scale: 1.7, minDepth: 0.4, reach: 7.5,
    palettes: {
      azure: { a: '#2b8be8', b: '#9ad6ff', c: '#0b2f57', d: '#12407a', ink: '#6eb6ff' },
      amber: { a: '#e58a24', b: '#ffd690', c: '#4a2506', d: '#7a3d0c', ink: '#ffb561' },
      lime: { a: '#9dbb2c', b: '#e6f584', c: '#2c3a08', d: '#4f6212', ink: '#c5dd5a' },
      rose: { a: '#e2476d', b: '#ffadbf', c: '#4d0d1f', d: '#7d1c36', ink: '#ff7d9a' }
    },
    spawn: function (e) {
      e.items = baseSpawn(e, countOf(e, this.count), function (c) {
        c.rate = 6 + e.rnd() * 3;
      });
    },
    tapDefault: 'scare',
    taps: {
      // бабочки рядом бросаются врассыпную
      scare: function (e, x, y) {
        scare(e, x, y, 34 * e.unit, function (c, ang) {
          c.fl = 0.7 + e.rnd() * 0.6;
          c.fa = ang + (e.rnd() - 0.5) * 0.9;
          c.fk = 1;
          c.boost = 1;
          c.gl = 0;
        });
        splash(e, x, y, 1.2);
      }
    },
    update: function (e, dt) {
      var it = e.items, i, c, v, f, sp = e.o.speed, u = e.unit, m = ext(e, 7.5);
      for (i = 0; i < it.length; i++) {
        c = it[i];
        steer(e, c, dt, c.s * 14,
          (Math.sin(e.t * 1.3 + c.o1) * 1.4 + Math.sin(e.t * 3.1 + c.o2) * 1.2) * sp, 5, 5);
        separate(e, c, dt, 5, 10 * u);
        c.boost *= Math.exp(-dt * 1.2);
        // полёт: серии взмахов и короткие планирования с раскрытыми крыльями
        if (c.gl > 0) {
          c.gl -= dt * sp;
        } else {
          c.ph += dt * c.rate * sp * (1 + 0.8 * c.boost);
          if (c.boost < 0.2 && e.rnd() < dt * 0.35) c.gl = 0.35 + e.rnd() * 0.5;
        }
        c.go += ((c.gl > 0 ? 1 : 0) - c.go) * Math.min(1, dt * 8);
        v = (9 + 5 * c.z) * u * sp * (1 + 1.6 * c.boost) *
          (c.gl > 0 ? 0.8 : 0.85 + 0.3 * Math.abs(Math.sin(c.ph)));
        c.x += Math.cos(c.a) * v * dt;
        c.y += Math.sin(c.a) * v * dt;
        wrap(e, c, m);
        // пыльца с кончиков крыльев
        f = 5.5 * c.s * (0.35 + 0.65 * Math.abs(Math.cos(c.ph)));
        shed(e, c.x - Math.sin(c.a) * f, c.y + Math.cos(c.a) * f, 0.1, dt);
        shed(e, c.x + Math.sin(c.a) * f, c.y - Math.cos(c.a) * f, 0.1, dt);
      }
    },
    draw: function (e, g) {
      var it = e.items, P = e.pal, i, c, f, sd, s, bob, bx, by;
      for (i = 0; i < it.length; i++) {
        c = it[i];
        f = 0.35 + 0.65 * Math.abs(Math.cos(c.ph));
        f += (1 - f) * c.go * 0.9;
        s = c.s;
        // тело покачивается поперёк курса в такт взмахам
        bob = Math.sin(c.ph * 2) * 0.35 * (1 - c.go) * s;
        bx = c.x - Math.sin(c.a) * bob;
        by = c.y + Math.cos(c.a) * bob;
        g.globalAlpha = 1;
        for (sd = -1; sd <= 1; sd += 2) {
          // кайма
          place(g, bx, by, c.a, s);
          g.scale(1, sd * f);
          g.fillStyle = P.d;
          butterflyWings(g);
          // основной тон: то же крыло, стянутое к телу
          place(g, bx, by, c.a, s);
          g.scale(0.8, sd * f * 0.8);
          g.fillStyle = P.a;
          butterflyWings(g);
          // светлые поля и пятна на кайме
          place(g, bx, by, c.a, s);
          g.scale(1, sd * f);
          g.fillStyle = P.b;
          ell(g, 1.6, 3.0, 0.9, 1.6, 0.15);
          ell(g, -1.7, 2.2, 0.7, 1.0, -0.6);
          ell(g, 2.7, 4.6, 0.38, 0.38);
          ell(g, 1.9, 5.5, 0.34, 0.34);
          ell(g, -2.6, 3.6, 0.36, 0.36);
        }
        place(g, bx, by, c.a, s);
        g.fillStyle = P.c;
        ell(g, -0.6, 0, 1.9, 0.42);
        ell(g, 1.3, 0, 0.9, 0.55);
        ell(g, 2.5, 0, 0.55, 0.55);
        g.strokeStyle = P.b;
        g.lineWidth = 0.28;
        g.globalAlpha = 0.7;
        g.beginPath();
        g.moveTo(2.8, 0.2); g.lineTo(4.4, 1.4);
        g.moveTo(2.8, -0.2); g.lineTo(4.4, -1.4);
        g.stroke();
      }
    }
  };

  /* Карпы кои: вид сверху. Позвоночник — цепочка костей, тянущихся за головой
     с ограничением изгиба в суставе; поверх неё бежит волна плавания.
     Окрас задаёт порода: рисунок считается шумом по телу, у каждой рыбы свой. */
  var KOI_R = [1.2, 1.7, 1.95, 2.05, 2.0, 1.9, 1.75, 1.55, 1.3, 1.05, 0.85, 0.65, 0.5];
  var KOI_N = KOI_R.length;
  var KOI_D = 0.9;      // расстояние между костями в единицах рыбы
  var KOI_BEND = 0.3;   // предел изгиба в одном суставе, рад
  var kx = new Array(KOI_N), ky = new Array(KOI_N), ka = new Array(KOI_N);

  var KOI_BREEDS = [
    { name: 'kohaku', base: '#f4ecdc', p1: '#e2422a', p2: null, fin: '#f3ddc8' },
    { name: 'sanke', base: '#f4ecdc', p1: '#e2422a', p2: '#1c1c22', fin: '#f3ddc8' },
    { name: 'showa', base: '#22222b', p1: '#de4228', p2: '#f2eee6', fin: '#5a5a66' },
    { name: 'ogon', base: '#eeb640', p1: '#ffe08f', p2: null, fin: '#ffe1a0' },
    { name: 'chagoi', base: '#a8763e', p1: '#c9975c', p2: null, fin: '#c9a070' }
  ];

  // Цвет пятна породы в точке тела по двум значениям шума; null — базовый цвет.
  function koiPatch(b, n1, n2) {
    if (b.name === 'kohaku') return n1 > 0.52 ? b.p1 : null;
    if (b.name === 'sanke') return n2 > 0.84 ? b.p2 : (n1 > 0.55 ? b.p1 : null);
    if (b.name === 'showa') return n1 > 0.5 ? b.p1 : (n2 > 0.6 ? b.p2 : null);
    return n1 > 0.72 ? b.p1 : null; // ogon, chagoi: редкие светлые чешуи
  }

  function koiChain(c) {
    var n = c.n, s = c.s, D = KOI_D * s, j, ang, prev, d;
    var hx = c.x + Math.cos(c.a) * 5.2 * s, hy = c.y + Math.sin(c.a) * 5.2 * s;
    if (!c.init) {
      for (j = 0; j < KOI_N; j++) {
        n[j * 2] = hx - Math.cos(c.a) * D * j;
        n[j * 2 + 1] = hy - Math.sin(c.a) * D * j;
      }
      c.init = true;
    }
    n[0] = hx; n[1] = hy;
    prev = c.a + PI;
    for (j = 1; j < KOI_N; j++) {
      ang = Math.atan2(n[j * 2 + 1] - n[j * 2 - 1], n[j * 2] - n[j * 2 - 2]);
      d = Math.atan2(Math.sin(ang - prev), Math.cos(ang - prev));
      if (d > KOI_BEND) d = KOI_BEND; else if (d < -KOI_BEND) d = -KOI_BEND;
      ang = prev + d;
      n[j * 2] = n[j * 2 - 2] + Math.cos(ang) * D;
      n[j * 2 + 1] = n[j * 2 - 1] + Math.sin(ang) * D;
      prev = ang;
    }
  }

  var KOI_INK = '#8cc4ee';

  scenes.koi = {
    label: 'Koi', dot: '#ffb02e', count: 6, palette: 'mix',
    scale: 1.9, minDepth: 0.5, reach: 11,
    water: { mood: 'sun', bottom: [10, 40, 56] },
    // палитра здесь = порода; mix раздаёт случайные
    palettes: {
      mix: { a: '#f2b632', ink: KOI_INK },
      kohaku: { a: '#e2422a', ink: KOI_INK, breed: 0 },
      sanke: { a: '#f4ecdc', ink: KOI_INK, breed: 1 },
      showa: { a: '#3a3a46', ink: KOI_INK, breed: 2 },
      ogon: { a: '#eeb640', ink: KOI_INK, breed: 3 },
      chagoi: { a: '#a8763e', ink: KOI_INK, breed: 4 }
    },
    spawn: function (e) {
      e.food = [];
      e.items = baseSpawn(e, countOf(e, this.count), function (c) {
        var j, l, A = e.rnd() * TAU, B = e.rnd() * TAU, C = e.rnd() * TAU, D = e.rnd() * TAU;
        c.breed = (e.rnd() * KOI_BREEDS.length) | 0;
        c.n = new Float32Array(KOI_N * 2);
        c.init = false;
        c.n1 = []; c.n2 = [];
        for (j = 0; j < KOI_N - 2; j++) {
          for (l = -1; l <= 1; l++) {
            c.n1.push(0.5 + 0.3 * Math.sin(j * 0.8 + A) * Math.cos(l * 1.1 + B) +
              0.2 * Math.sin(j * 1.9 + l * 2.3 + C));
            c.n2.push(0.5 + 0.3 * Math.sin(j * 1.3 + C) * Math.cos(l * 1.7 + D) +
              0.2 * Math.sin(j * 2.6 - l * 1.9 + A));
          }
        }
      });
    },
    tapDefault: 'food',
    taps: {
      // в воду падает корм, рыбы поблизости сплываются его есть
      food: function (e, x, y) {
        var n = 6 + ((e.rnd() * 4) | 0), i, a, r;
        for (i = 0; i < n; i++) {
          a = e.rnd() * TAU;
          r = 5 * e.unit * Math.sqrt(e.rnd());
          e.food.push({
            x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
            vx: Math.cos(a) * (0.4 + e.rnd()), vy: Math.sin(a) * (0.4 + e.rnd()), t: 0
          });
          e.disturb(x + Math.cos(a) * r, y + Math.sin(a) * r, 1.2);
        }
        if (e.food.length > 50) e.food.splice(0, e.food.length - 50);
        splash(e, x, y, 2.5);
      },
      // рыбы рядом шарахаются прочь рывком
      scare: function (e, x, y) {
        scare(e, x, y, 40 * e.unit, function (c, ang) {
          c.fl = 0.9 + e.rnd() * 0.6;
          c.fa = ang + (e.rnd() - 0.5) * 0.7;
          c.fk = 1;
          c.boost = 1;
        });
        splash(e, x, y, 3);
      }
    },
    update: function (e, dt) {
      var it = e.items, food = e.food, sp = e.o.speed, u = e.unit, m = ext(e, 12);
      var range = 42 * u, i, j, c, v, f, hx, hy, dx, dy, d, best, bestD, last;
      for (i = food.length - 1; i >= 0; i--) {
        f = food[i];
        f.t += dt;
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.vx *= Math.exp(-dt * 0.8); f.vy *= Math.exp(-dt * 0.8);
        if (f.t > 14) food.splice(i, 1);
      }
      for (i = 0; i < it.length; i++) {
        c = it[i];
        // корм: рыба поворачивает к ближайшей крошке, чем ближе — тем резче и быстрее
        if (food.length) {
          hx = c.x + Math.cos(c.a) * 5.2 * c.s;
          hy = c.y + Math.sin(c.a) * 5.2 * c.s;
          best = -1; bestD = range;
          for (j = 0; j < food.length; j++) {
            dx = food[j].x - hx; dy = food[j].y - hy;
            d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) { bestD = d; best = j; }
          }
          if (best >= 0) {
            if (bestD < 1.6 * c.s + 1) {
              splash(e, food[best].x, food[best].y, 1.5);
              food.splice(best, 1);
            } else {
              c.fl = 0.05;
              c.fa = Math.atan2(food[best].y - hy, food[best].x - hx);
              c.fk = 0.3 + 0.5 * (1 - bestD / range);
            }
          }
        }
        // тяжёлая рыба: разворачивается плавно, тело складывается дугой за головой
        steer(e, c, dt, c.s * 14,
          (Math.sin(e.t * 0.35 + c.o1) * 0.45 + Math.sin(e.t * 0.9 + c.o2) * 0.3) * sp, 2.4, 3);
        separate(e, c, dt, 6, 6 * u);
        c.boost *= Math.exp(-dt * 0.9);
        c.ph += dt * (2.2 + 6 * c.boost) * sp; // при рывке хвост бьёт чаще
        v = (7 + 3 * c.z) * u * sp * (1 + 2.2 * c.boost);
        c.x += Math.cos(c.a) * v * dt;
        c.y += Math.sin(c.a) * v * dt;
        if (wrap(e, c, m)) c.init = false;
        koiChain(c);
        // хвост и голова гонят волны по воде, при рывке сильнее
        last = (KOI_N - 1) * 2;
        shed(e, c.n[last], c.n[last + 1], 0.3 * Math.sin(c.ph) * (1 + 2 * c.boost), dt);
        shed(e, c.n[0], c.n[1], 0.1, dt);
      }
    },
    draw: function (e, g) {
      var it = e.items, food = e.food, P = e.pal;
      var i, j, l, c, s, n, b, uu, amp, off, tx, ty, tl, sw, sd, ta, bx, by, col, r, qx, qy, fx, fy, hx, hy;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // корм
      g.fillStyle = '#e8b268';
      for (i = 0; i < food.length; i++) {
        g.globalAlpha = food[i].t > 10 ? 1 - (food[i].t - 10) / 4 : 1;
        dot(g, food[i].x, food[i].y, 0.55);
      }
      for (i = 0; i < it.length; i++) {
        c = it[i];
        if (!c.init) continue;
        s = c.s; n = c.n;
        b = KOI_BREEDS[P.breed === undefined ? c.breed : P.breed];
        // точки тела: кости + бегущая волна, нарастающая к хвосту
        amp = 0.9 + 0.8 * c.boost;
        for (j = 0; j < KOI_N; j++) {
          l = j > 0 ? j - 1 : 0;
          r = j < KOI_N - 1 ? j + 1 : KOI_N - 1;
          tx = n[r * 2] - n[l * 2]; ty = n[r * 2 + 1] - n[l * 2 + 1];
          tl = Math.sqrt(tx * tx + ty * ty) || 1;
          tx /= tl; ty /= tl;
          uu = j / (KOI_N - 1);
          off = Math.sin(c.ph - j * 0.5) * (0.1 + 0.9 * uu * uu) * amp * s;
          kx[j] = n[j * 2] - ty * off;
          ky[j] = n[j * 2 + 1] + tx * off;
          ka[j] = Math.atan2(-ty, -tx); // направление к голове
        }
        // грудные (у жабр) и брюшные плавники
        sw = Math.sin(c.ph * 0.5) * 0.22;
        g.fillStyle = b.fin;
        g.globalAlpha = 0.7;
        for (sd = -1; sd <= 1; sd += 2) {
          qx = -Math.sin(ka[2]) * sd; qy = Math.cos(ka[2]) * sd;
          fan(g, kx[2] + qx * KOI_R[2] * 0.75 * s, ky[2] + qy * KOI_R[2] * 0.75 * s,
            ka[2] + sd * (PI - 1.0 - sw), 3.6 * s, sd * 1.35 * s);
          qx = -Math.sin(ka[7]) * sd; qy = Math.cos(ka[7]) * sd;
          fan(g, kx[7] + qx * KOI_R[7] * 0.6 * s, ky[7] + qy * KOI_R[7] * 0.6 * s,
            ka[7] + sd * (PI - 0.7), 2.0 * s, sd * 0.75 * s);
        }
        // хвост: две лопасти, отстают от волны тела
        bx = kx[KOI_N - 1]; by = ky[KOI_N - 1];
        ta = ka[KOI_N - 1] + PI + Math.sin(c.ph - KOI_N * 0.5 - 0.6) * 0.35 * amp;
        g.globalAlpha = 0.75;
        fan(g, bx, by, ta + 0.36, 5.0 * s, 1.5 * s);
        fan(g, bx, by, ta - 0.36, 5.0 * s, -1.5 * s);
        // тело и морда
        fx = Math.cos(c.a); fy = Math.sin(c.a);
        g.globalAlpha = 1;
        g.fillStyle = b.base;
        for (j = KOI_N - 1; j >= 0; j--) dot(g, kx[j], ky[j], KOI_R[j] * s);
        dot(g, kx[0] + fx * 0.75 * s, ky[0] + fy * 0.75 * s, 0.8 * s);
        // окрас породы
        for (j = 0; j < KOI_N - 2; j++) {
          qx = -Math.sin(ka[j]); qy = Math.cos(ka[j]);
          r = KOI_R[j] * s;
          for (l = -1; l <= 1; l++) {
            col = koiPatch(b, c.n1[j * 3 + l + 1], c.n2[j * 3 + l + 1]);
            if (!col) continue;
            g.fillStyle = col;
            dot(g, kx[j] + qx * l * 0.5 * r, ky[j] + qy * l * 0.5 * r, 0.5 * r);
          }
        }
        // спинной плавник
        g.strokeStyle = b.fin;
        g.lineWidth = 0.4 * s;
        g.globalAlpha = 0.85;
        g.beginPath();
        g.moveTo(kx[3], ky[3]);
        for (j = 4; j <= 8; j++) g.lineTo(kx[j], ky[j]);
        g.stroke();
        // усики и глаза
        hx = kx[0]; hy = ky[0];
        qx = -fy; qy = fx;
        g.lineWidth = 0.22 * s;
        g.beginPath();
        for (sd = -1; sd <= 1; sd += 2) {
          g.moveTo(hx + (fx * 1.3 + qx * 0.45 * sd) * s, hy + (fy * 1.3 + qy * 0.45 * sd) * s);
          g.lineTo(hx + (fx * 2.0 + qx * 1.0 * sd) * s, hy + (fy * 2.0 + qy * 1.0 * sd) * s);
        }
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = b.name === 'showa' ? '#f2eee6' : '#15161a';
        for (sd = -1; sd <= 1; sd += 2) {
          dot(g, hx + (fx * 0.1 + qx * 0.85 * sd) * s, hy + (fy * 0.1 + qy * 0.85 * sd) * s, 0.34 * s);
        }
      }
    }
  };

  /* Медузы: вид сбоку, купол пульсирует и толкает тело, щупальца тянутся следом. */
  scenes.jellyfish = {
    label: 'Jellyfish', dot: '#ff5cc8', count: 8, palette: 'neon',
    scale: 1.6, minDepth: 0.45, reach: 12,
    palettes: {
      neon: { a: '#d946b5', b: '#ffc4ee', t: '#f07ad0', ink: '#ff8fdc' },
      moon: { a: '#3fa9d6', b: '#dcf8ff', t: '#7fd6ee', ink: '#8fe0f5' },
      ember: { a: '#e8641f', b: '#ffdcb5', t: '#ff9c5a', ink: '#ffab70' },
      violet: { a: '#6a48e6', b: '#ddd3ff', t: '#a18cff', ink: '#b3a1ff' }
    },
    spawn: function (e) {
      e.items = baseSpawn(e, countOf(e, this.count), function (c) {
        c.a = -PI / 2 + (e.rnd() - 0.5);
        c.rate = 1.8 + e.rnd() * 0.8;
        c.tl = 0.8 + e.rnd() * 0.5;
      });
    },
    tapDefault: 'shock',
    taps: {
      // ударная волна: медуз отбрасывает, они сжимаются и вспыхивают
      shock: function (e, x, y) {
        scare(e, x, y, 36 * e.unit, function (c, ang, k) {
          c.vx += Math.cos(ang) * k * 34 * e.unit;
          c.vy += Math.sin(ang) * k * 34 * e.unit;
          c.ph = 0;
          c.glow = 1;
        });
        splash(e, x, y, 3);
      }
    },
    update: function (e, dt) {
      var it = e.items, i, c, k, v, sp = e.o.speed, u = e.unit, m = ext(e, 13);
      for (i = 0; i < it.length; i++) {
        c = it[i];
        k = near(e, c, c.s * 11);
        c.ph += dt * c.rate * sp * (1 + 1.5 * k);
        c.a = turnTo(c.a, -PI / 2 + Math.sin(e.t * 0.25 + c.o1) * 0.6, dt * 0.5);
        separate(e, c, dt, 4.5, 4 * u);
        v = (2 + 5 * Math.max(0, Math.cos(c.ph))) * u * sp * (0.6 + 0.4 * c.z);
        // курсор толкает медузу: она набирает скорость и плавно гасит её, как в воде
        if (k > 0) {
          c.vx += Math.cos(e._pa) * k * 40 * u * dt;
          c.vy += Math.sin(e._pa) * k * 40 * u * dt;
        }
        c.vx *= Math.exp(-dt * 1.6);
        c.vy *= Math.exp(-dt * 1.6);
        c.glow *= Math.exp(-dt * 1.4);
        c.x += (Math.cos(c.a) * v + c.vx) * dt;
        c.y += (Math.sin(c.a) * v + c.vy) * dt;
        wrap(e, c, m);
        // свечение: ярче на толчке купола и после вспышки
        shed(e, c.x, c.y, 0.1 + 0.2 * Math.max(0, Math.cos(c.ph)) + 0.8 * c.glow, dt);
      }
    },
    draw: function (e, g) {
      var it = e.items, P = e.pal, i, j, k, c, p, bw, bh, y0, d;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (i = 0; i < it.length; i++) {
        c = it[i];
        p = 0.5 + 0.5 * Math.sin(c.ph);
        bw = 3.4 * (1 - 0.2 * p);
        bh = 3.1 * (1 + 0.16 * p);
        place(g, c.x, c.y, c.a, c.s);
        // вспышка после клика
        if (c.glow > 0.03) {
          g.fillStyle = P.b;
          g.globalAlpha = c.glow * 0.45;
          ell(g, 0.6, 0, bh * 1.5, bw * 1.45);
        }
        // щупальца
        g.strokeStyle = P.t;
        g.lineWidth = 0.45;
        g.globalAlpha = 0.5;
        for (j = 0; j < 8; j++) {
          y0 = (j / 7 - 0.5) * 1.7 * bw;
          g.beginPath();
          g.moveTo(0, y0);
          for (k = 1; k <= 7; k++) {
            d = k * 1.5 * c.tl;
            g.lineTo(-d, y0 * (1 - 0.25 * k / 7) + Math.sin(c.ph - k * 0.75 + j * 1.3) * 0.7 * k / 7);
          }
          g.stroke();
        }
        // ротовые лопасти
        g.strokeStyle = P.b;
        g.lineWidth = 1.0;
        g.globalAlpha = 0.8;
        for (j = -1; j <= 1; j++) {
          g.beginPath();
          g.moveTo(0, j * 1.0);
          for (k = 1; k <= 5; k++) {
            g.lineTo(-k * 1.2, j * 1.0 + Math.sin(c.ph - k * 0.9 + j) * 0.6 * k / 5);
          }
          g.stroke();
        }
        // купол: край, средний пояс, светлая сердцевина
        g.globalAlpha = 1;
        g.fillStyle = P.a;
        g.beginPath();
        g.ellipse(0, 0, bh, bw, 0, -PI / 2, PI / 2);
        g.closePath();
        g.fill();
        ell(g, 0, 0, 0.55, bw);
        g.fillStyle = P.t;
        g.beginPath();
        g.ellipse(0.2, 0, bh * 0.8, bw * 0.78, 0, -PI / 2, PI / 2);
        g.closePath();
        g.fill();
        g.fillStyle = P.b;
        g.beginPath();
        g.ellipse(0.5, 0, bh * 0.5, bw * 0.5, 0, -PI / 2, PI / 2);
        g.closePath();
        g.fill();
        // светлые точки по краю купола
        for (j = -2; j <= 2; j++) ell(g, 0.1, j * bw * 0.42, 0.3, 0.3);
      }
    }
  };

  /* Стрекозы: зависание и рывки; четыре раздельных крыла, сегментированное брюшко, глаза. */
  scenes.dragonfly = {
    label: 'Dragonfly', dot: '#2fd9a4', count: 7, palette: 'emerald',
    scale: 1.5, minDepth: 0.45, reach: 9,
    palettes: {
      emerald: { a: '#12b88c', b: '#8ff5d2', w: '#c9fff0', ink: '#6ee8c4' },
      sapphire: { a: '#2f7df0', b: '#a9cfff', w: '#d6e9ff', ink: '#7fb3ff' },
      ruby: { a: '#e23b4e', b: '#ffa3ad', w: '#ffd9dd', ink: '#ff7f8d' },
      gold: { a: '#d9a514', b: '#ffe392', w: '#fff3c9', ink: '#f2c94c' }
    },
    spawn: function (e) {
      e.items = baseSpawn(e, countOf(e, this.count), function (c) {
        c.tm = e.rnd() * 1.5;
        c.v = 0;
        c.ta = c.a;
      });
    },
    tapDefault: 'scare',
    taps: {
      // стрекозы рядом мгновенно срываются прочь
      scare: function (e, x, y) {
        scare(e, x, y, 38 * e.unit, function (c, ang, k) {
          c.ta = ang + (e.rnd() - 0.5) * 0.6;
          c.v = (34 + 20 * k) * e.unit;
          c.tm = 0.9 + e.rnd();
        });
        splash(e, x, y, 1.2);
      }
    },
    update: function (e, dt) {
      var it = e.items, i, c, k, vv, sp = e.o.speed, u = e.unit, m = ext(e, 9);
      for (i = 0; i < it.length; i++) {
        c = it[i];
        c.ph += dt * 38;
        c.tm -= dt * sp;
        k = near(e, c, c.s * 13);
        if (c.tm <= 0 || (k > 0.3 && c.v < 10 * u)) {
          c.ta = k > 0 ? e._pa + (e.rnd() - 0.5) * 0.8 : c.a + (e.rnd() - 0.5) * 4.2;
          c.v = (26 + e.rnd() * 16) * u * (0.6 + 0.4 * c.z);
          c.tm = 0.7 + e.rnd() * 1.8;
        }
        c.a = turnTo(c.a, c.ta, dt * 9);
        separate(e, c, dt, 5.5, 8 * u);
        c.v *= Math.exp(-dt * 2.4);
        vv = c.v * sp + 0.8 * u;
        c.x += (Math.cos(c.a) * vv + Math.sin(e.t * 5 + c.o1) * 0.6 * u) * dt;
        c.y += (Math.sin(c.a) * vv + Math.cos(e.t * 4.3 + c.o2) * 0.6 * u) * dt;
        wrap(e, c, m);
        // след остаётся только на рывке
        if (c.v > 5 * u) shed(e, c.x, c.y, 0.22, dt);
      }
    },
    draw: function (e, g) {
      var it = e.items, P = e.pal, i, j, c, wb, sd;
      for (i = 0; i < it.length; i++) {
        c = it[i];
        wb = Math.sin(c.ph) * 0.14;
        place(g, c.x, c.y, c.a, c.s);
        // крылья: передняя пара вперёд, задняя назад, между ними просвет
        g.fillStyle = P.w;
        g.globalAlpha = 0.62 + 0.1 * Math.cos(c.ph * 0.5);
        for (sd = -1; sd <= 1; sd += 2) {
          ell(g, 2.2, sd * 4.3, 0.95, 4.0, sd * (-0.28 + wb));
          ell(g, 0.1, sd * 4.0, 1.15, 3.7, sd * (0.32 - wb));
        }
        // тёмные метки у кончиков крыльев
        g.fillStyle = P.a;
        g.globalAlpha = 1;
        for (sd = -1; sd <= 1; sd += 2) {
          ell(g, 3.1, sd * 7.3, 0.42, 0.42);
          ell(g, -0.9, sd * 6.9, 0.42, 0.42);
        }
        // брюшко из чередующихся сегментов
        for (j = 0; j < 8; j++) {
          g.fillStyle = (j % 2) ? P.b : P.a;
          ell(g, 0.2 - j * 1.0, 0, 0.62, 0.5 - j * 0.025);
        }
        // грудь, голова, глаза
        g.fillStyle = P.a;
        ell(g, 1.7, 0, 1.45, 0.95);
        g.fillStyle = P.b;
        ell(g, 1.8, 0, 0.8, 0.45);
        g.fillStyle = P.a;
        ell(g, 3.3, 0, 0.6, 0.6);
        g.fillStyle = P.b;
        ell(g, 3.5, 0.6, 0.52, 0.52);
        ell(g, 3.5, -0.6, 0.52, 0.52);
      }
    }
  };

  /* Лягушки: прыгают с кувшинки на кувшинку, пруд медленно дрейфует. */
  var FROG_K = 1.5; // крупность лягушек и кувшинок

  // Лист качнулся: вода расходится от его кромки по всей окружности, а не из одной точки.
  function padRing(e, pd, amt) {
    var r = pd.r * e.unit * e.o.size * FROG_K + 0.8, n = Math.ceil(r * 4), i, a;
    for (i = 0; i < n; i++) {
      a = i / n * TAU;
      e.disturb(pd.x + Math.cos(a) * r, pd.y + Math.sin(a) * r, amt);
    }
  }

  scenes.frog = {
    label: 'Frog', dot: '#5fd85a', count: 5, palette: 'leaf',
    reach: 8, flat: true,
    water: { mood: 'leaves', bottom: [13, 46, 36] },
    palettes: {
      leaf: { a: '#3fbf4a', b: '#b4f08a', d: '#1e7a2e', e: '#fff3a0', pad: '#1f6b3c', ink: '#6fdc7a' },
      dart: { a: '#2a6df0', b: '#8fd6ff', d: '#123a9a', e: '#ffe14a', pad: '#17506b', ink: '#6aa8ff' },
      moss: { a: '#8a9a2e', b: '#dbe487', d: '#55611a', e: '#fff0b0', pad: '#3c4f1c', ink: '#b7c75a' },
      tomato: { a: '#e2472e', b: '#ffb78a', d: '#8f2212', e: '#fff2c0', pad: '#1f5a45', ink: '#ff8a66' }
    },
    scaleOf: function (e, c) { return e.unit * e.o.size * FROG_K * (0.8 + 0.3 * c.z); },
    spawn: function (e) {
      var n = countOf(e, this.count), np = Math.max(n + 3, Math.round(n * 1.8)), i, pd;
      e.pads = [];
      e.tapX = 0; e.tapY = 0;
      for (i = 0; i < np; i++) {
        e.pads.push({
          x: e.rnd() * e.cols, y: e.rnd() * e.rows, r: 4.2 + e.rnd() * 2.4,
          rot: e.rnd() * TAU, o: e.rnd() * TAU, busy: i < n
        });
      }
      e.items = [];
      for (i = 0; i < n; i++) {
        pd = e.pads[i];
        e.items.push({
          pad: i, to: -1, x: pd.x, y: pd.y, sx: 0, sy: 0, a: e.rnd() * TAU, s: 1,
          z: e.rnd(), o1: e.rnd() * TAU, tm: 1 + e.rnd() * 4, j: 0, aim: 0, dur: 0.6, sc: 0
        });
      }
    },
    tapDefault: 'scare',
    taps: {
      // всплеск, лягушки поблизости спрыгивают подальше от него
      scare: function (e, x, y) {
        e.tapX = x; e.tapY = y;
        scare(e, x, y, 34 * e.unit, function (c) { c.sc = 1; });
        splash(e, x, y, 4);
      }
    },
    update: function (e, dt) {
      var pads = e.pads, it = e.items, sp = e.o.speed, u = e.unit, P = e.pointer;
      var i, j, c, pd, tp, k, m, idx, best, bestD, d, dx, dy, uu, ee, away, rx, ry;
      for (i = 0; i < pads.length; i++) {
        pd = pads[i];
        m = (pd.r + 7) * u * e.o.size * FROG_K;
        pd.x += 0.5 * u * sp * dt;
        pd.y += 0.18 * u * sp * dt;
        if (pd.x > e.cols + m) pd.x = -m;
        if (pd.y > e.rows + m) pd.y = -m;
        // лист лежит на воде: под ним волн нет, чужие волны об него гасятся
        e.calm(pd.x, pd.y, pd.r * u * e.o.size * FROG_K * 0.92);
      }
      for (i = 0; i < it.length; i++) {
        c = it[i];
        if (c.j > 0) {
          // в прыжке
          tp = pads[c.to];
          c.j += dt / c.dur * sp;
          uu = c.j > 1 ? 1 : c.j;
          ee = uu * uu * (3 - 2 * uu);
          c.x = c.sx + (tp.x - c.sx) * ee;
          c.y = c.sy + (tp.y - c.sy) * ee;
          if (uu >= 1) {
            c.pad = c.to; c.to = -1; c.j = 0;
            c.tm = 1.2 + e.rnd() * 4;
            padRing(e, tp, 0.5); // приземление качает лист
          }
          continue;
        }
        pd = pads[c.pad];
        c.x = pd.x; c.y = pd.y;
        if (c.aim > 0) {
          // разворот к цели перед прыжком
          tp = pads[c.to];
          c.aim -= dt * sp;
          c.a = turnTo(c.a, Math.atan2(tp.y - c.y, tp.x - c.x), dt * 12 * sp);
          if (c.aim <= 0) {
            dx = tp.x - c.x; dy = tp.y - c.y;
            c.sx = c.x; c.sy = c.y;
            c.dur = 0.5 + Math.sqrt(dx * dx + dy * dy) / (60 * u);
            c.j = 0.0001;
            pd.busy = false;
            padRing(e, pd, 0.25); // толчок от кувшинки
          }
          continue;
        }
        c.tm -= dt * sp;
        k = near(e, c, 14 * u * e.o.size * FROG_K);
        if (c.tm <= 0 || k > 0.25 || c.sc) {
          // от курсора или клика выбираем кувшинку подальше, иначе — первую подходящую
          away = k > 0 || c.sc;
          rx = c.sc ? e.tapX : P.x; ry = c.sc ? e.tapY : P.y;
          best = -1; bestD = -1;
          for (j = 0; j < 8; j++) {
            idx = (e.rnd() * pads.length) | 0;
            tp = pads[idx];
            if (tp.busy || idx === c.pad) continue;
            if (tp.x < 8 * u || tp.x > e.cols - 8 * u || tp.y < 6 * u || tp.y > e.rows - 6 * u) continue;
            dx = tp.x - c.x; dy = tp.y - c.y;
            d = Math.sqrt(dx * dx + dy * dy);
            if (d < 12 * u || d > 60 * u) continue;
            d = away ? Math.sqrt((tp.x - rx) * (tp.x - rx) + (tp.y - ry) * (tp.y - ry)) : 1;
            if (d > bestD) { bestD = d; best = idx; }
            if (!away) break;
          }
          c.sc = 0;
          if (best >= 0) {
            c.to = best;
            pads[best].busy = true;
            c.aim = 0.35;
          } else {
            c.tm = 0.6;
          }
        }
      }
    },
    draw: function (e, g) {
      var pads = e.pads, it = e.items, P = e.pal, u = e.unit * e.o.size * FROG_K;
      var i, c, pd, hop, s, sd;
      for (i = 0; i < pads.length; i++) {
        pd = pads[i];
        place(g, pd.x, pd.y, pd.rot, u);
        g.fillStyle = P.pad;
        g.globalAlpha = 0.62 + 0.05 * Math.sin(e.t + pd.o);
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, pd.r, 0.28, TAU - 0.28);
        g.closePath();
        g.fill();
        // прожилки листа
        g.strokeStyle = P.d;
        g.lineWidth = 0.35;
        g.globalAlpha = 0.5;
        g.beginPath();
        g.moveTo(0, 0); g.lineTo(-pd.r * 0.85, 0);
        g.moveTo(0, 0); g.lineTo(-pd.r * 0.3, pd.r * 0.8);
        g.moveTo(0, 0); g.lineTo(-pd.r * 0.3, -pd.r * 0.8);
        g.stroke();
      }
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (i = 0; i < it.length; i++) {
        c = it[i];
        hop = c.j > 0 ? Math.sin(PI * (c.j > 1 ? 1 : c.j)) : 0;
        s = c.s * (1 + 0.45 * hop) * (1 + 0.03 * Math.sin(e.t * 3 + c.o1));
        if (c.aim > 0) s *= 0.94;
        place(g, c.x, c.y, c.a, s);
        g.globalAlpha = 1;
        // лапы и ступни
        g.strokeStyle = P.a;
        g.fillStyle = P.b;
        g.lineWidth = 1.0;
        for (sd = -1; sd <= 1; sd += 2) {
          g.beginPath();
          g.moveTo(-1.4, sd * 1.3);
          g.lineTo(-1.0 - 2.4 * hop, sd * (3.0 - 1.1 * hop));
          g.lineTo(0.4 - 6.4 * hop, sd * (3.3 - 1.6 * hop));
          g.stroke();
          ell(g, 0.7 - 6.9 * hop, sd * (3.5 - 1.7 * hop), 0.75, 0.5);
          g.beginPath();
          g.moveTo(1.3, sd * 1.2);
          g.lineTo(2.2 + 1.4 * hop, sd * (2.6 - 1.3 * hop));
          g.stroke();
          ell(g, 2.5 + 1.5 * hop, sd * (2.8 - 1.4 * hop), 0.5, 0.4);
        }
        // тело, полоса по спине, пятна, глаза
        g.fillStyle = P.a;
        ell(g, 0, 0, 2.7, 2.0);
        ell(g, 2.1, 0, 1.5, 1.55);
        g.fillStyle = P.b;
        ell(g, -0.1, 0, 1.9, 0.6);
        g.fillStyle = P.d;
        ell(g, -0.9, 1.1, 0.5, 0.42);
        ell(g, -0.9, -1.1, 0.5, 0.42);
        ell(g, 0.7, 1.2, 0.42, 0.36);
        ell(g, 0.7, -1.2, 0.42, 0.36);
        g.fillStyle = P.e;
        ell(g, 2.7, 1.05, 0.6, 0.6);
        ell(g, 2.7, -1.05, 0.6, 0.6);
      }
    }
  };

  /* ---------- движок ---------- */

  function Engine(target, options) {
    if (!(this instanceof Engine)) return new Engine(target, options);
    var self = this, o = this.o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (k in options) if (options[k] !== undefined) o[k] = options[k];

    if (target && target.getContext) {
      this.canvas = target;
      this.own = false;
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'display:block;width:100%;height:100%';
      target.appendChild(this.canvas);
      this.own = true;
    }
    this.ctx = this.canvas.getContext('2d');
    this.mask = document.createElement('canvas');   // слой 1: существа
    this.mctx = this.mask.getContext('2d', { willReadFrequently: true });
    this.idm = document.createElement('canvas');    // слой 2: владельцы клеток
    this.ictx = this.idm.getContext('2d', { willReadFrequently: true });
    this.fxc = document.createElement('canvas');    // слой 4: свечение дымки (воздух)
    this.fctx = this.fxc.getContext('2d');
    this.gl = null;                                 // слой 4: вода, WebGL создаётся при первом кадре
    this.glFail = false;
    this.lo = document.createElement('canvas');     // уменьшенная копия для блума и размытия
    this.lctx = this.lo.getContext('2d');
    this.pointer = { x: 0, y: 0, on: false, moved: false, idle: 0, power: 0 };
    this.stats = { fps: 0, cells: 0 };
    this.styles = {};
    this.idStyles = [];
    for (k = 0; k < 256; k++) this.idStyles.push('rgb(' + k + ',0,0)');
    // данные владельцев: позиция, поворот и затухание существа с номером 1..255
    this.ox = new Float32Array(256); this.oy = new Float32Array(256);
    this.oc = new Float32Array(256); this.os = new Float32Array(256);
    this.of = new Float32Array(256);
    this.items = [];
    this.t = 0;
    this.running = false;
    this._chk = 0;
    this._pa = 0;
    this._facc = 0;

    this._tick = function (now) { self._frame(now); };
    this._onMove = function (ev) {
      var t = ev.touches ? ev.touches[0] : ev;
      if (!t) return;
      var P = self.pointer, r = self.canvas.getBoundingClientRect();
      var x = t.clientX - r.left, y = t.clientY - r.top;
      if (!r.width || x < 0 || y < 0 || x > r.width || y > r.height) { P.on = false; return; }
      var k = self.canvas.width / r.width / self.cell;
      P.x = x * k; P.y = y * k;
      P.on = true; P.moved = true; P.idle = 0;
    };
    this._onLeave = function () { self.pointer.on = false; };
    this._onResize = function () { self.resize(); };
    this._onDown = function (ev) {
      if (self.o.tapAction === 'none') return;
      // клики по интерфейсу поверх сцены не считаются
      var el = ev.target, cv = self.canvas;
      if (el !== cv && el !== cv.parentNode && el !== document.body && el !== document.documentElement) return;
      var t = ev.touches ? ev.touches[0] : ev;
      if (t) self.tap(t.clientX, t.clientY);
    };
    window.addEventListener('mousemove', this._onMove, false);
    window.addEventListener('touchmove', this._onMove, false);
    window.addEventListener('touchend', this._onLeave, false);
    window.addEventListener('mousedown', this._onDown, false);
    window.addEventListener('touchstart', this._onDown, false);
    document.documentElement.addEventListener('mouseleave', this._onLeave, false);
    window.addEventListener('resize', this._onResize, false);

    this.resize();
    this.setScene(o.scene);
  }

  Engine.prototype.resize = function () {
    var c = this.canvas, o = this.o;
    var w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, o.maxDpr);
    this.cssW = w; this.cssH = h;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    var cell = Math.max(4, Math.round((o.cell > 0 ? o.cell : w / o.cols) * dpr));
    this.cell = cell;
    var cols = this.cols = Math.ceil(c.width / cell);
    var rows = this.rows = Math.ceil(c.height / cell);
    this.unit = cols / 150; // базовый масштаб существ: размер относительно экрана постоянен
    this.mask.width = this.idm.width = this.fxc.width = cols;
    this.mask.height = this.idm.height = this.fxc.height = rows;
    this.lo.width = Math.max(1, c.width >> 2);
    this.lo.height = Math.max(1, c.height >> 2);
    var n = cols * rows;
    this.h0 = new Float32Array(n);   // поле: текущее состояние
    this.h1 = new Float32Array(n);   // поле: предыдущее состояние / буфер
    this.sw = cols * 2;              // волны: сетка вдвое мельче клеток
    this.sh = rows * 2;
    this.w0 = new Float32Array(this.sw * this.sh);
    this.w1 = new Float32Array(this.sw * this.sh);
    this.wpx = new Uint8Array(this.sw * this.sh * 4); // высоты, упакованные для текстуры
    this.fxImg = this.fctx.createImageData(cols, rows);
    this.glyphs = o.glyphs;
    // чёрный атлас: поверх плитки с прозрачностью даёт тёмный оттенок её же цвета
    this.atlasD = makeAtlas(this.glyphs, cell, '#000000');

    var st = c.style, ratio = c.width / w;
    st.backgroundColor = o.background;
    if (o.grid) {
      var tile = document.createElement('canvas');
      tile.width = cell; tile.height = cell;
      var tg = tile.getContext('2d');
      tg.fillStyle = o.gridColor;
      tg.fillRect(0, 0, cell, 1);
      tg.fillRect(0, 1, 1, cell - 1);
      st.backgroundImage = 'url(' + tile.toDataURL() + ')';
      st.backgroundSize = (cell / ratio) + 'px ' + (cell / ratio) + 'px';
    } else {
      st.backgroundImage = 'none';
    }
    if (this.scene) { this._palette(); this._spawn(); }
    return this;
  };

  Engine.prototype._palette = function () {
    var s = this.scene, name = s.palettes[this.o.palette] ? this.o.palette : s.palette;
    this.palName = name;
    this.pal = s.palettes[name];
    this.inkRgb = hexRgb(this.pal.ink);
    this.atlasI = makeAtlas(this.glyphs, this.cell, this.pal.ink);
  };

  Engine.prototype._spawn = function () {
    this.rnd = mulberry32((this.o.seed | 0) * 9973 + 17);
    this.h0.fill(0);
    this.h1.fill(0);
    this.w0.fill(0);
    this.w1.fill(0);
    this.items = [];
    this.scene.spawn(this);
  };

  Engine.prototype.setScene = function (name) {
    if (!scenes[name]) name = 'butterfly';
    this.o.scene = name;
    this.scene = scenes[name];
    this._palette();
    this._spawn();
    return this;
  };

  Engine.prototype.set = function (patch) {
    var o = this.o, ch = {}, k;
    for (k in patch) if (o[k] !== patch[k]) { o[k] = patch[k]; ch[k] = 1; }
    if (ch.scene) this.scene = scenes[o.scene] || scenes.butterfly;
    if (ch.cell || ch.cols || ch.maxDpr || ch.grid || ch.gridColor || ch.background || ch.glyphs) {
      return this.resize();
    }
    if (ch.scene || ch.palette) this._palette();
    if (ch.scene || ch.count || ch.seed || ch.farBias) this._spawn();
    return this;
  };

  Engine.prototype.start = function () {
    if (this.running) return this;
    this.running = true;
    this._last = (window.performance && performance.now) ? performance.now() : Date.now();
    this._raf = requestAnimationFrame(this._tick);
    return this;
  };

  Engine.prototype.stop = function () {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    return this;
  };

  Engine.prototype.destroy = function () {
    this.stop();
    window.removeEventListener('mousemove', this._onMove, false);
    window.removeEventListener('touchmove', this._onMove, false);
    window.removeEventListener('touchend', this._onLeave, false);
    window.removeEventListener('mousedown', this._onDown, false);
    window.removeEventListener('touchstart', this._onDown, false);
    document.documentElement.removeEventListener('mouseleave', this._onLeave, false);
    window.removeEventListener('resize', this._onResize, false);
    if (this.own && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  // Возмутить поле в клетке (x, y): волна на воде или порция дымки.
  Engine.prototype.disturb = function (x, y, amt) {
    var cx, cy, w, sw, i;
    if (this.scene.water) {
      // толчок в поле волн мягким пятном 3x3: точечный удар даёт шахматную рябь
      sw = this.sw; w = this.w0;
      cx = (x * 2) | 0; cy = (y * 2) | 0;
      if (cx < 2 || cy < 2 || cx >= sw - 2 || cy >= this.sh - 2) return;
      i = cy * sw + cx;
      w[i] += amt;
      w[i - 1] += amt * 0.5; w[i + 1] += amt * 0.5; w[i - sw] += amt * 0.5; w[i + sw] += amt * 0.5;
      w[i - sw - 1] += amt * 0.25; w[i - sw + 1] += amt * 0.25;
      w[i + sw - 1] += amt * 0.25; w[i + sw + 1] += amt * 0.25;
      return;
    }
    cx = x | 0; cy = y | 0;
    if (cx < 1 || cy < 1 || cx >= this.cols - 1 || cy >= this.rows - 1) return;
    this.h0[cy * this.cols + cx] += amt;
  };

  // Успокоить воду в круге (центр и радиус в клетках): так плавающие предметы гасят волны под собой.
  Engine.prototype.calm = function (x, y, r) {
    var sw = this.sw, sh = this.sh, w0 = this.w0, w1 = this.w1;
    var cx = x * 2, cy = y * 2, rr = r * 2, r2 = rr * rr;
    var x0 = Math.max(1, Math.floor(cx - rr)), x1 = Math.min(sw - 2, Math.ceil(cx + rr));
    var y0 = Math.max(1, Math.floor(cy - rr)), y1 = Math.min(sh - 2, Math.ceil(cy + rr));
    var px, py, i;
    for (py = y0; py <= y1; py++) {
      for (px = x0; px <= x1; px++) {
        if ((px - cx) * (px - cx) + (py - cy) * (py - cy) < r2) {
          i = py * sw + px;
          w0[i] = 0; w1[i] = 0;
        }
      }
    }
  };

  // Действие сцены в точке экрана (координаты окна, как у события мыши).
  Engine.prototype.tap = function (clientX, clientY) {
    var r = this.canvas.getBoundingClientRect();
    if (!r.width) return this;
    var k = this.canvas.width / r.width / this.cell;
    var x = (clientX - r.left) * k, y = (clientY - r.top) * k;
    var sc = this.scene, act = this.o.tapAction || sc.tapDefault;
    if (act === 'none') return this;
    if (sc.taps && sc.taps[act]) sc.taps[act](this, x, y);
    else splash(this, x, y, 2.5); // 'splash' и неизвестные действия: только всплеск
    return this;
  };

  Engine.prototype._frame = function (now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);
    if (now - this._last < 1000 / this.o.fps - 3) return;
    var dt = (now - this._last) / 1000;
    this._last = now;
    if (dt <= 0) return;
    this.stats.fps = this.stats.fps * 0.9 + (1 / dt) * 0.1;
    if (dt > 0.1) dt = 0.1;

    // контейнер мог получить размер позже создания (так вставляет заставку Lampa)
    if (++this._chk >= 30) {
      this._chk = 0;
      var cv = this.canvas;
      if ((cv.clientWidth || window.innerWidth) !== this.cssW ||
          (cv.clientHeight || window.innerHeight) !== this.cssH) this.resize();
    }

    var P = this.pointer, target, it = this.items, sc = this.scene, i;
    P.idle += dt;
    target = P.on ? 1 - (P.idle - 2.5) / 1.5 : 0;
    if (target > 1) target = 1; else if (target < 0) target = 0;
    P.power += (target - P.power) * Math.min(1, dt * 6);

    this.t += dt;
    for (i = 0; i < it.length; i++) it[i].s = sc.scaleOf ? sc.scaleOf(this, it[i]) : depthScale(this, it[i]);
    sc.update(this, dt);
    // движение курсора оставляет лёгкую дымку в воздушных сценах; воду оно не трогает
    if (P.moved && P.on && !sc.water && this.o.pointer !== 'none') this.disturb(P.x, P.y, 0.25);
    P.moved = false;
    if (this.o.fx) { if (sc.water) this._waves(dt); else this._field(dt); }
    this._render();
  };

  // Дымка воздушных сцен: размытие по соседям и угасание.
  // Шаг с фиксированной частотой 30 Гц, чтобы вид не зависел от fps.
  Engine.prototype._field = function (dt) {
    var cols = this.cols, rows = this.rows, tr = this.o.trail;
    var h0, h1, x, y, i, k, steps = 0, tmp;
    if (tr > 1) tr = 1; else if (tr < 0) tr = 0;
    k = Math.exp(-(1 / 30) / (0.12 + tr * 1.5));
    this._facc += dt;
    while (this._facc >= 1 / 30 && steps < 2) {
      this._facc -= 1 / 30;
      steps++;
      h0 = this.h0; h1 = this.h1;
      for (y = 1; y < rows - 1; y++) {
        i = y * cols + 1;
        for (x = 1; x < cols - 1; x++, i++) {
          h1[i] = (h0[i] * 4 + h0[i - 1] + h0[i + 1] + h0[i - cols] + h0[i + cols]) * 0.125 * k;
        }
      }
      tmp = this.h0; this.h0 = this.h1; this.h1 = tmp;
    }
    if (this._facc > 0.1) this._facc = 0;
  };

  // Световой слой воздушных сцен в разрешении сетки: свечение дымки и пятно у курсора.
  Engine.prototype._light = function () {
    var o = this.o, cols = this.cols, rows = this.rows, h = this.h0;
    var px = this.fxImg.data, ink = this.inkRgb;
    var P = this.pointer, glow = o.glow ? P.power : 0, gx = P.x, gy = P.y, R = 16 * this.unit, R2 = R * R;
    var x, y, i = 0, p = 0, l, dx, dy, dd, L;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++, i++, p += 4) {
        L = h[i] * 0.6;
        if (glow > 0.01) {
          dx = x - gx; dy = y - gy; dd = dx * dx + dy * dy;
          if (dd < R2) { l = 1 - dd / R2; L += l * l * glow * 0.35; }
        }
        if (L < 0.015) { px[p + 3] = 0; continue; }
        px[p] = ink[0]; px[p + 1] = ink[1]; px[p + 2] = ink[2];
        px[p + 3] = (L > 0.6 ? 0.6 : L) * 255;
      }
    }
    this.fctx.putImageData(this.fxImg, 0, 0);
  };

  /* ----- вода: симуляция волн + шейдер ----- */

  var WATER_VS = [
    'attribute vec2 aPos;',
    'uniform vec2 uScale;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5) * uScale;', // (0,0) — левый верхний угол
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Пруд, вид сверху. Свет идёт по тому же пути, что в настоящей воде:
  //   1. Поверхность: только волны из симуляции — их поднимают существа, клики и прыжки.
  //      Спокойная вода ровная и свет не преломляет.
  //   2. Дно: видно сквозь воду со сдвигом по наклону волны, поэтому оно дрожит.
  //   3. Каустика: каждая точка поверхности работает как линза. Там, где лучи сходятся на дне,
  //      яркость растёт как 1 / |det(I + кривизна)| — получаются тонкие нити света, а не пятна;
  //      где расходятся — дно чуть темнее.
  //   4. Условия освещения (uMode) задают тень на дне: 0 листва — пятна тени от кроны,
  //      1 облака — большие медленные тени, 2 солнце — тени нет, 3 луна — слабый холодный свет.
  //   5. На самой поверхности — только мелкие искры на гранях, повёрнутых к источнику света.
  var WATER_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uH;',
    'uniform vec2 uTexel;',
    'uniform float uAspect;',
    'uniform float uT;',
    'uniform float uAmb;',
    'uniform float uRip;',
    'uniform float uMode;',
    'uniform vec3 uLit;',
    'uniform vec3 uBot;',
    'uniform vec3 uGrid;',
    'uniform vec3 uPtr;',
    'varying vec2 vUv;',
    'float hgt(vec2 uv) {',
    '  vec4 s = texture2D(uH, uv);',
    '  return (s.r * 0.996109 + s.g * 0.003891) * 2.0 - 1.0;', // высота упакована в два байта: старший и младший
    '}',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),',
    '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'float fbm3(vec2 p) {',
    '  float s = 0.5 * vnoise(p);',
    '  p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 + 11.7;',
    '  s += 0.25 * vnoise(p);',
    '  p = mat2(0.28, -0.96, 0.96, 0.28) * p * 2.11 + 5.3;',
    '  return s + 0.125 * vnoise(p);',
    '}',
    'void main() {',
    '  vec2 p = vec2(vUv.x * uAspect, vUv.y);',
    // волны из симуляции: наклон и кривизна из соседних точек
    '  vec2 o = uTexel * 1.5;',
    '  float hc = hgt(vUv);',
    '  float hl = hgt(vUv - vec2(o.x, 0.0)), hr = hgt(vUv + vec2(o.x, 0.0));',
    '  float hu = hgt(vUv - vec2(0.0, o.y)), hd = hgt(vUv + vec2(0.0, o.y));',
    '  vec2 g = vec2(hr - hl, hd - hu) * uRip;',
    '  float hxx = (hl + hr - 2.0 * hc) * uRip * 10.0;',
    '  float hyy = (hu + hd - 2.0 * hc) * uRip * 10.0;',
    // каустика: сходятся лучи — ярко, расходятся — темнее
    '  float det = (1.0 + hxx) * (1.0 + hyy);',
    '  float ca = clamp((1.0 / (abs(det) + 0.1) - 0.9) * 0.22, -0.12, 1.0);',
    // дно сквозь воду
    '  vec2 pb = p + g * 0.5;',
    '  float shade;',   // сколько света доходит до дна
    '  float spkK;',    // сила искр на поверхности
    '  vec2 facet = vec2(0.04, -0.055);', // наклон грани, которая блестит
    '  if (uMode < 0.5) {',
    '    vec2 sway = vec2(sin(uT * 0.4), cos(uT * 0.33)) * 0.08;', // крона покачивается
    '    shade = 0.12 + 0.88 * smoothstep(0.42, 0.58, fbm3(pb * 3.5 + sway));',
    '    spkK = 1.0;',
    '  } else if (uMode < 1.5) {',
    '    shade = 0.3 + 0.7 * smoothstep(0.36, 0.66, fbm3(p * 1.2 + vec2(uT * 0.025, uT * 0.01)));', // ветер несёт облака
    '    spkK = 0.6;',
    '  } else if (uMode < 2.5) {',
    '    shade = 1.0;',
    '    spkK = 1.0;',
    '  } else {',
    '    shade = 0.3;',
    '    spkK = 0.4 + 3.0 * exp(-pow((p.x - 0.5 * uAspect) / 0.2, 2.0));', // лунная дорожка
    '    facet = vec2(0.0, -0.06);',
    '  }',
    '  vec3 col = uBot * (0.55 + 0.6 * fbm3(pb * 8.0)) * (0.6 + 0.6 * shade);',
    '  col += uLit * ca * shade * uAmb * 0.6;',
    '  float spk = smoothstep(0.016, 0.0, length(g - facet));',
    '  col += uLit * spk * spkK * max(shade, 0.3) * 0.8;',
    '  float pd = distance(p, vec2(uPtr.x * uAspect, uPtr.y));',
    '  col += uLit * uPtr.z * pow(max(0.0, 1.0 - pd / 0.22), 2.0) * 0.15;',
    // линии сетки клеток поверх дна, чтобы вода не выпадала из ASCII-картинки
    '  vec2 gc = fract(vUv * uGrid.xy);',
    '  if (gc.x < uGrid.z || gc.y < uGrid.z) col += vec3(0.035);',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  // Условия освещения пруда: номер режима шейдера и цвет света.
  var MOODS = {
    leaves: { id: 0, lit: [215, 235, 150] },
    clouds: { id: 1, lit: [215, 232, 255] },
    sun: { id: 2, lit: [255, 244, 214] },
    moon: { id: 3, lit: [150, 180, 255] }
  };

  Engine.prototype._initGL = function () {
    var cv = document.createElement('canvas'), gl = null, self = this;
    try {
      gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }) ||
        cv.getContext('experimental-webgl');
    } catch (err) { gl = null; }
    if (!gl) { this.glFail = true; return; }
    function shader(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        if (window.console) console.warn('ascii-life: шейдер воды не собрался', gl.getShaderInfoLog(sh));
        self.glFail = true;
      }
      return sh;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, WATER_VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, WATER_FS));
    gl.linkProgram(prog);
    if (this.glFail || !gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.glFail = true; return; }
    gl.useProgram(prog);
    var buf = gl.createBuffer(), loc = gl.getAttribLocation(prog, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.gtex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gtex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.gu = {
      scale: gl.getUniformLocation(prog, 'uScale'), texel: gl.getUniformLocation(prog, 'uTexel'),
      aspect: gl.getUniformLocation(prog, 'uAspect'), t: gl.getUniformLocation(prog, 'uT'),
      amb: gl.getUniformLocation(prog, 'uAmb'), rip: gl.getUniformLocation(prog, 'uRip'),
      mode: gl.getUniformLocation(prog, 'uMode'), bot: gl.getUniformLocation(prog, 'uBot'),
      grid: gl.getUniformLocation(prog, 'uGrid'),
      lit: gl.getUniformLocation(prog, 'uLit'), ptr: gl.getUniformLocation(prog, 'uPtr')
    };
    this.glc = cv;
    this.gl = gl;
  };

  // Волны: высота новой клетки из четырёх соседей и прошлого значения, с затуханием.
  // Сетка вдвое мельче клеток; шаг с фиксированной частотой 30 Гц.
  Engine.prototype._waves = function (dt) {
    var sw = this.sw, sh = this.sh, tr = this.o.trail, w0, w1, x, y, i, k, steps = 0, tmp;
    if (tr > 1) tr = 1; else if (tr < 0) tr = 0;
    k = 0.955 + 0.04 * tr;
    this._facc += dt;
    while (this._facc >= 1 / 30 && steps < 2) {
      this._facc -= 1 / 30;
      steps++;
      w0 = this.w0; w1 = this.w1;
      for (y = 1; y < sh - 1; y++) {
        i = y * sw + 1;
        for (x = 1; x < sw - 1; x++, i++) {
          w1[i] = ((w0[i - 1] + w0[i + 1] + w0[i - sw] + w0[i + sw]) * 0.5 - w1[i]) * k;
        }
      }
      tmp = this.w0; this.w0 = this.w1; this.w1 = tmp;
    }
    if (this._facc > 0.1) this._facc = 0;
  };

  // Рисует воду шейдером в свой холст. Возвращает false, если WebGL недоступен.
  Engine.prototype._water = function () {
    if (!this.gl && !this.glFail) this._initGL();
    if (!this.gl) return false;
    var gl = this.gl, cv = this.glc, o = this.o, U = this.gu, P = this.pointer;
    var sw = this.sw, sh = this.sh, w = this.w0, px = this.wpx, n = sw * sh;
    var W = this.canvas.width, H = this.canvas.height;
    var mood = MOODS[o.waterMood] || MOODS[this.scene.water.mood], lt = mood.lit, bot = this.scene.water.bottom;
    var cw = Math.max(1, Math.round(W * o.waterScale)), chh = Math.max(1, Math.round(H * o.waterScale));
    var gw = this.cols * this.cell, gh = this.rows * this.cell; // размер сетки в пикселях, чуть больше холста
    var i, j = 0, v, q;
    if (cv.width !== cw || cv.height !== chh) { cv.width = cw; cv.height = chh; }
    for (i = 0; i < n; i++, j += 4) {
      v = w[i] * 0.25;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      q = ((v * 0.5 + 0.5) * 65535) | 0;
      px[j] = q >> 8;
      px[j + 1] = q & 255;
    }
    gl.viewport(0, 0, cw, chh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.gtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.uniform2f(U.scale, W / gw, H / gh);
    gl.uniform2f(U.texel, 1 / sw, 1 / sh);
    gl.uniform1f(U.aspect, gw / gh);
    gl.uniform1f(U.t, this.t);
    gl.uniform1f(U.amb, o.waterLight);
    gl.uniform1f(U.rip, 3);
    gl.uniform1f(U.mode, mood.id);
    gl.uniform3f(U.bot, bot[0] / 255, bot[1] / 255, bot[2] / 255);
    gl.uniform3f(U.grid, this.cols, this.rows, o.grid ? 1 / this.cell : -1);
    gl.uniform3f(U.lit, lt[0] / 255, lt[1] / 255, lt[2] / 255);
    gl.uniform3f(U.ptr, P.x / this.cols, P.y / this.rows, o.glow ? P.power : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  };

  Engine.prototype._render = function () {
    var o = this.o, cols = this.cols, rows = this.rows, cell = this.cell, ctx = this.ctx;
    var sc = this.scene, it = this.items, g = this.mctx, ig = this.ictx;
    var W = this.canvas.width, H = this.canvas.height;
    var i, c, r, id;

    // слой 1: существа
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, cols, rows);
    sc.draw(this, g);
    var d = g.getImageData(0, 0, cols, rows).data;

    // слой 2: владельцы клеток — квадраты по целым координатам, без сглаживания
    var ox = this.ox, oy = this.oy, oc = this.oc, os = this.os, of = this.of;
    ig.clearRect(0, 0, cols, rows);
    for (i = 0; i < it.length && i < 255; i++) {
      c = it[i];
      r = Math.ceil(c.s * (sc.reach || 8));
      ig.fillStyle = this.idStyles[i + 1];
      ig.fillRect(Math.round(c.x) - r, Math.round(c.y) - r, r * 2, r * 2);
      ox[i + 1] = c.x; oy[i + 1] = c.y;
      oc[i + 1] = Math.cos(c.a); os[i + 1] = Math.sin(c.a);
      of[i + 1] = sc.flat ? 1 : 1 - o.fog * (1 - c.z) * 0.75;
    }
    var idd = ig.getImageData(0, 0, cols, rows).data;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);

    // слой 4: свет, растянутый со сглаживанием — мягкий, в отличие от чётких плиток
    if (o.fx) {
      ctx.imageSmoothingEnabled = true;
      if (sc.water) {
        if (this._water()) ctx.drawImage(this.glc, 0, 0, W, H);
      } else {
        this._light();
        ctx.drawImage(this.fxc, 0, 0, cols, rows, 0, 0, cols * cell, rows * cell);
      }
    }
    ctx.imageSmoothingEnabled = false;

    // слой 5: клетки
    var styles = this.styles, TILE = 0.28;
    var P = this.pointer, glow = o.glow ? P.power : 0, gx = P.x, gy = P.y;
    var R = 16 * this.unit, R2 = R * R;
    var seed = o.seed | 0, ng = this.glyphs.length, dark = this.atlasD, ink = this.atlasI;
    var gap = cell >= 7 ? 1 : 0, ts = cell - gap, tg = o.tileGlyphs, tone = o.glyphTone;
    var lastKey = -1, cells = 0;
    var x, y, p = 0, v, l, dx, dy, dd, n, f, gi, b, key, fd;
    i = 0;

    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++, i++, p += 4) {
        if (d[p + 3] < 12) continue;
        v = d[p + 3] / 255;
        // фактура привязана к телу владельца: считаем номер клетки в его системе координат
        id = idd[p + 3] === 255 ? idd[p] : 0;
        if (id) {
          dx = x + 0.5 - ox[id]; dy = y + 0.5 - oy[id];
          n = hash2(Math.round(dx * oc[id] + dy * os[id]), Math.round(dy * oc[id] - dx * os[id]), id * 7919 + seed);
          fd = of[id];
        } else {
          n = hash2(x, y, seed);
          fd = 1;
        }
        f = hash2((n * 1048576) | 0, 17, 5);
        l = 0;
        if (glow > 0.01) {
          dx = x - gx; dy = y - gy; dd = dx * dx + dy * dy;
          if (dd < R2) { l = 1 - dd / R2; l = l * l * glow; }
        }
        if (v < TILE) {
          // неполная клетка: только символ
          b = (v * 2.4 + l * 0.4) * fd;
          if (b < 0.05) continue;
          if (b > 1) b = 1;
          gi = 1 + ((v / TILE * 3.2 + n * 2.2) | 0);
          if (gi > ng - 1) gi = ng - 1;
          ctx.globalAlpha = b;
          ctx.drawImage(ink, gi * cell, 0, cell, cell, x * cell, y * cell, cell, cell);
        } else {
          // плитка
          b = (0.6 + 0.4 * (v - TILE) / (1 - TILE)) * (0.82 + 0.3 * n) * fd;
          b += l * 0.4;
          if (b > 1) b = 1;
          key = (d[p] >> 3) << 10 | (d[p + 1] >> 3) << 5 | (d[p + 2] >> 3);
          if (key !== lastKey) {
            ctx.fillStyle = styles[key] ||
              (styles[key] = 'rgb(' + (d[p] & 248) + ',' + (d[p + 1] & 248) + ',' + (d[p + 2] & 248) + ')');
            lastKey = key;
          }
          ctx.globalAlpha = b;
          ctx.fillRect(x * cell + gap, y * cell + gap, ts, ts);
          if (tg > 0 && f < tg) {
            gi = 3 + ((n * (ng - 3)) | 0);
            if (gi > ng - 1) gi = ng - 1;
            ctx.globalAlpha = tone * (0.75 + 0.25 * f);
            ctx.drawImage(dark, gi * cell, 0, cell, cell, x * cell, y * cell, cell, cell);
          }
        }
        cells++;
      }
    }
    this.stats.cells = cells;

    // слой 6: блум и размытие через уменьшенную вчетверо копию кадра
    if (o.bloom > 0 || o.blur > 0) {
      var lc = this.lctx, lo = this.lo;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, lo.width, lo.height);
      lc.filter = 'blur(2px)';
      lc.drawImage(this.canvas, 0, 0, lo.width, lo.height);
      lc.filter = 'none';
      ctx.imageSmoothingEnabled = true;
      if (o.blur > 0) {
        ctx.globalAlpha = o.blur > 1 ? 1 : o.blur;
        ctx.drawImage(lo, 0, 0, W, H);
      }
      if (o.bloom > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = o.bloom > 1 ? 1 : o.bloom;
        ctx.drawImage(lo, 0, 0, W, H);
        if (o.bloom > 1) {
          ctx.globalAlpha = o.bloom - 1;
          ctx.drawImage(lo, 0, 0, W, H);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  };

  Engine.scenes = scenes;
  Engine.DEFAULTS = DEFAULTS;
  Engine.MOODS = MOODS;
  Engine.helpers = {
    baseSpawn: baseSpawn, countOf: countOf, depthScale: depthScale, ext: ext, wrap: wrap,
    near: near, steer: steer, separate: separate, scare: scare, shed: shed, splash: splash,
    place: place, ell: ell, dot: dot, fan: fan, turnTo: turnTo
  };
  return Engine;
});
