/*!
 * jellies.js - a jellyfish scene for ascii-life.js.
 *
 * Load it after ascii-life.js. It registers AsciiLife.scenes.jelly using the engine's own
 * helpers, so ascii-life.js itself stays unmodified:
 *
 *   <script src="ascii-life.js"></script>
 *   <script src="jellies.js"></script>
 *   new AsciiLife(el, { scene: 'jelly', palette: 'mix' }).start();
 *
 * Palettes (a palette here is a colour of jellyfish):
 *   mix      pink/purple, blue and yellow together
 *   orchid   purple rim, pink bell
 *   blue     blue
 *   yellow   yellow
 *   pink     pink
 *   purple   purple
 *
 * Side view, like the engine's own jellyfish: the dome points the way the jellyfish is heading
 * (+x in the drawing units below), the tentacles trail behind. One unit is about 3 grid cells.
 *
 * How it moves:
 *   - The bell pulses: a quick squeeze, then a slow relaxed refill. The squeeze is what pushes
 *     the body (speed is added in proportion to how much the bell closed), and the water drag
 *     lets it glide and slowly sink between pulses, so it travels in surges.
 *   - Tentacles and oral arms are chains dragged through the water: each joint is pulled gently
 *     toward where it would hang, near the bell firmly and toward the tip loosely, so they stream
 *     out behind on a surge, bunch up on a pulse, and swing out wide when the jellyfish turns.
 */
(function () {
  'use strict';
  if (typeof AsciiLife === 'undefined' || !AsciiLife.scenes || !AsciiLife.helpers) return;

  var H = AsciiLife.helpers;
  var baseSpawn = H.baseSpawn, countOf = H.countOf, ext = H.ext, wrap = H.wrap, steer = H.steer;
  var separate = H.separate, scare = H.scare, shed = H.shed, splash = H.splash;
  var place = H.place, ell = H.ell, dot = H.dot;
  var PI = Math.PI, TAU = Math.PI * 2;

  // rim: the edge of the bell. mid: the body of the bell. core: the bright centre.
  // tent: tentacles. arm: the frilly oral arms. spot: dots along the rim.
  var BREEDS = [
    { name: 'orchid', rim: '#8a52e6', mid: '#e263c6', core: '#ffc8f2', tent: '#d887ef', arm: '#ffd0f6', spot: '#ffe4fa' },
    { name: 'blue', rim: '#2c80d6', mid: '#58c2f0', core: '#d4f5ff', tent: '#7ccdf2', arm: '#c4efff', spot: '#eefaff' },
    { name: 'yellow', rim: '#dc9a14', mid: '#f5cf46', core: '#fff3b0', tent: '#f6d96a', arm: '#fff0a8', spot: '#fffbe0' },
    { name: 'pink', rim: '#da3f98', mid: '#ff86cd', core: '#ffd9f0', tent: '#f57cc4', arm: '#ffd2ee', spot: '#fff0f8' },
    { name: 'purple', rim: '#5a3cd6', mid: '#9b82fa', core: '#ddd3ff', tent: '#a690ff', arm: '#d9ceff', spot: '#f1edff' }
  ];

  var NT = 9;          // thin tentacles
  var NA = 4;          // frilly oral arms
  var TN = 9;          // joints per tentacle
  var TL = 1.35;       // length of one tentacle joint, drawing units
  var AN = 6;          // joints per oral arm
  var AL = 0.95;       // length of one oral-arm joint
  var PUSH = 7.5;      // thrust: cells per second (times unit) added by one full squeeze
  var DRAG = 1.25;     // water drag, per second: lower = longer glides
  var SINK = 1.0;      // how fast a resting jellyfish sinks (times unit, per second squared)
  var SQUEEZE = 0.34;  // share of the pulse cycle spent squeezing; the rest is the slow refill

  function smooth(x) { return x * x * (3 - 2 * x); }

  // 0 = relaxed, 1 = fully squeezed, for pulse phase q in 0..1
  function squeezeAt(q) {
    if (q < SQUEEZE) return smooth(q / SQUEEZE);
    return 1 - smooth((q - SQUEEZE) / (1 - SQUEEZE));
  }

  // The bell outline in drawing units: a dome that points along +x with a scooped, flared underside.
  // w = half width at the rim, h = height of the dome, lip = how far the rim flares back (-x).
  function bellPath(g, w, h, lip, cx) {
    g.beginPath();
    g.moveTo(cx - lip, -w);
    g.bezierCurveTo(cx + h * 0.15, -w * 1.02, cx + h, -w * 0.62, cx + h, 0);
    g.bezierCurveTo(cx + h, w * 0.62, cx + h * 0.15, w * 1.02, cx - lip, w);
    g.quadraticCurveTo(cx + h * 0.28, w * 0.5, cx + h * 0.28, 0);
    g.quadraticCurveTo(cx + h * 0.28, -w * 0.5, cx - lip, -w);
    g.closePath();
  }

  // Where tentacle j hangs from, as a share of the rim (-1..1), and the same for the oral arms.
  function rimShare(j, n) { return n < 2 ? 0 : (j / (n - 1) - 0.5) * 2; }

  // Bell size right now, from the squeeze: wide and flared at rest, narrow and tucked when closed.
  function bellShape(sq) {
    return { w: 3.9 - 1.25 * sq, h: 2.9 + 0.55 * sq, lip: 0.55 - 0.75 * sq };
  }

  // Put every joint of every chain where it would hang right now (used at the start and after a wrap).
  function resetChains(e, c) {
    var j, k, ch, ca = Math.cos(c.a), sa = Math.sin(c.a), s = c.s, b = bellShape(0), lx, ly;
    c.ch = [];
    for (j = 0; j < NT + NA; j++) {
      ch = { n: j < NT ? TN : AN, f: j < NT ? rimShare(j, NT) : rimShare(j - NT, NA), p: [] };
      for (k = 0; k < ch.n; k++) {
        lx = -b.lip - k * (j < NT ? TL : AL) * c.tl;
        ly = ch.f * b.w * (j < NT ? 0.92 : 0.28);
        ch.p.push({ x: c.x + (ca * lx - sa * ly) * s, y: c.y + (sa * lx + ca * ly) * s });
      }
      c.ch.push(ch);
    }
  }

  function updateChains(e, c, dt, sq) {
    var j, k, ch, p, q, ca = Math.cos(c.a), sa = Math.sin(c.a), s = c.s, b = bellShape(sq);
    var isT, L, lx, ly, ix, iy, rate, dx, dy, d, sway, n;
    for (j = 0; j < c.ch.length; j++) {
      ch = c.ch[j];
      isT = j < NT;
      L = (isT ? TL : AL) * c.tl * s;
      n = ch.n;
      // the root is fixed to the underside of the bell
      lx = -b.lip + (isT ? 0 : 0.5);
      ly = ch.f * b.w * (isT ? 0.92 : 0.28);
      p = ch.p;
      p[0].x = c.x + (ca * lx - sa * ly) * s;
      p[0].y = c.y + (sa * lx + ca * ly) * s;
      for (k = 1; k < n; k++) {
        // where this joint would hang if nothing was dragging it: straight back, spread out a little,
        // and swaying side to side more and more toward the tip
        sway = Math.sin(e.t * 1.15 - k * 0.55 + j * 1.7 + c.o2) * 0.95 * (k / n) * (isT ? 1 : 0.6);
        lx = -b.lip - k * (isT ? TL : AL) * c.tl * (1 - 0.1 * sq);
        ly = ch.f * b.w * (isT ? 0.92 - 0.35 * k / n : 0.28) + sway * (isT ? 1.6 : 1) * TL;
        ix = c.x + (ca * lx - sa * ly) * s;
        iy = c.y + (sa * lx + ca * ly) * s;
        // firm near the bell, loose toward the tip: the tip trails and whips on a turn
        rate = (isT ? 6.5 : 7.5) * (1 - 0.82 * (k / (n - 1)));
        q = 1 - Math.exp(-rate * dt);
        p[k].x += (ix - p[k].x) * q;
        p[k].y += (iy - p[k].y) * q;
        // joints keep their length
        dx = p[k].x - p[k - 1].x;
        dy = p[k].y - p[k - 1].y;
        d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        p[k].x = p[k - 1].x + dx / d * L;
        p[k].y = p[k - 1].y + dy / d * L;
      }
    }
  }

  AsciiLife.scenes.jelly = {
    label: 'Jellyfish', dot: '#8ad2f6', count: 9, palette: 'mix',
    scale: 2.0, minDepth: 0.5, reach: 17,
    palettes: {
      mix: { a: '#9fb6ee', ink: '#a9c6ff' },
      orchid: { a: '#e263c6', ink: '#ff9fe0', breed: 0 },
      blue: { a: '#58c2f0', ink: '#9be0ff', breed: 1 },
      yellow: { a: '#f5cf46', ink: '#ffe48a', breed: 2 },
      pink: { a: '#ff86cd', ink: '#ffa8dc', breed: 3 },
      purple: { a: '#9b82fa', ink: '#b9a8ff', breed: 4 }
    },

    spawn: function (e) {
      var fixed = e.pal.breed, order = [0, 1, 2], j, k, t;
      // shuffled colour order, so every colour shows up equally often
      for (j = 2; j > 0; j--) {
        k = (e.rnd() * (j + 1)) | 0;
        t = order[j]; order[j] = order[k]; order[k] = t;
      }
      e.items = baseSpawn(e, countOf(e, this.count), function (c, i) {
        c.breed = fixed !== undefined ? fixed : order[i % 3];
        c.a = -PI / 2 + (e.rnd() - 0.5) * 1.2;
        c.rate = 0.55 + e.rnd() * 0.3;      // pulses per second
        c.pp = e.rnd();                     // where in the pulse it starts
        c.sq = squeezeAt(c.pp);
        c.tl = 0.8 + e.rnd() * 0.4;         // tentacle length
        c.dr = (e.rnd() - 0.5) * 2;         // which way it likes to drift, left or right of straight up
        c.ch = null;
      });
    },

    tapDefault: 'shock',
    taps: {
      // a shock wave: jellyfish nearby are shoved away, clench, and flash
      shock: function (e, x, y) {
        scare(e, x, y, 40 * e.unit, function (c, ang, k) {
          c.vx += Math.cos(ang) * k * 30 * e.unit;
          c.vy += Math.sin(ang) * k * 30 * e.unit;
          c.pp = 0;
          c.glow = 1;
        });
        splash(e, x, y, 2);
      }
    },

    update: function (e, dt) {
      var it = e.items, sp = e.o.speed, u = e.unit, m = ext(e, 20), i, c, k, q0, sq, dsq, pref, dv, depth, wander, dA;
      var en = e.o.energy === undefined ? 1 : e.o.energy;   // 0.4 calm .. 1.6 lively (the page's slider)
      for (i = 0; i < it.length; i++) {
        c = it[i];
        if (!c.ch) resetChains(e, c);
        k = H.near ? H.near(e, c, c.s * 12) : 0;

        // pulse: a pointer close by makes it pulse faster, to get away
        q0 = c.sq;
        c.pp += dt * c.rate * sp * en * (1 + 1.3 * k);
        if (c.pp >= 1) c.pp -= Math.floor(c.pp);
        sq = squeezeAt(c.pp);
        dsq = sq - q0;
        c.sq = sq;

        // steering: it likes to head up, wandering left and right, and turns slowly
        pref = -PI / 2 + c.dr * 0.65 + Math.sin(e.t * 0.13 + c.o1) * 0.55;
        dA = Math.atan2(Math.sin(pref - c.a), Math.cos(pref - c.a));
        wander = dA * 0.7 + Math.sin(e.t * 0.31 + c.o2) * 0.25 * en;
        steer(e, c, dt, 0, wander, 1.1, 1.6);
        separate(e, c, dt, 5, 5 * u);

        // thrust: speed gained in proportion to how much the bell closed, a little pulled back on refill
        depth = 0.65 + 0.35 * c.z;
        dv = PUSH * u * sp * (0.7 + 0.3 * en) * depth * (dsq > 0 ? dsq : dsq * 0.14);
        c.vx += Math.cos(c.a) * dv;
        c.vy += Math.sin(c.a) * dv;
        if (k > 0) {
          c.vx += Math.cos(e._pa) * k * 36 * u * dt;
          c.vy += Math.sin(e._pa) * k * 36 * u * dt;
        }
        c.vy += SINK * u * dt;                    // sinks a little between pulses
        c.vx *= Math.exp(-dt * DRAG);
        c.vy *= Math.exp(-dt * DRAG);
        c.glow *= Math.exp(-dt * 1.5);
        c.x += c.vx * dt;
        c.y += c.vy * dt;

        if (wrap(e, c, m)) c.ch = null;
        else updateChains(e, c, dt, sq);

        // a soft glow that swells on each squeeze
        shed(e, c.x, c.y, 0.05 + 0.5 * (dsq > 0 ? dsq * 8 : 0) * 0.1 + 0.7 * c.glow, dt);
      }
    },

    draw: function (e, g) {
      var it = e.items, P = e.pal, i, j, k, c, b, sq, sh, ch, p, s, wob, f, nx, ny, dx, dy, d, wv, half, w;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (i = 0; i < it.length; i++) {
        c = it[i];
        if (!c.ch) continue;
        b = BREEDS[P.breed === undefined ? c.breed : P.breed];
        s = c.s;
        sq = c.sq;
        sh = bellShape(sq);

        // ---- tentacles and oral arms: chains drawn in grid coordinates, behind the bell
        g.setTransform(1, 0, 0, 1, 0, 0);
        for (j = 0; j < c.ch.length; j++) {
          ch = c.ch[j];
          if (j < NT) {
            // thin tentacles: bright near the bell, fading toward the tip
            g.strokeStyle = b.tent;
            g.lineWidth = Math.max(0.7, 0.42 * s);
            for (half = 0; half < 2; half++) {
              g.globalAlpha = half ? 0.34 : 0.62;
              g.beginPath();
              for (k = half ? Math.floor(ch.n / 2) : 0; k < (half ? ch.n : Math.floor(ch.n / 2) + 1); k++) {
                p = ch.p[k];
                nx = p.x; ny = p.y;
                if (k > 0) {
                  dx = ch.p[k].x - ch.p[k - 1].x; dy = ch.p[k].y - ch.p[k - 1].y;
                  d = Math.sqrt(dx * dx + dy * dy) || 1;
                  wv = Math.sin(e.t * 2.1 - k * 0.9 + j * 1.3 + c.o1) * 0.22 * s * (k / ch.n);
                  nx += -dy / d * wv; ny += dx / d * wv;
                }
                if (k === (half ? Math.floor(ch.n / 2) : 0)) g.moveTo(nx, ny); else g.lineTo(nx, ny);
              }
              g.stroke();
            }
          } else {
            // oral arms: thicker, lighter ribbons with a frill that ripples down them
            g.strokeStyle = b.arm;
            g.globalAlpha = 0.6;
            for (k = 1; k < ch.n; k++) {
              f = k / (ch.n - 1);
              dx = ch.p[k].x - ch.p[k - 1].x; dy = ch.p[k].y - ch.p[k - 1].y;
              d = Math.sqrt(dx * dx + dy * dy) || 1;
              wv = Math.sin(e.t * 2.6 - k * 1.1 + j * 2.1 + c.o1) * 0.3 * s * f;
              g.lineWidth = Math.max(0.8, (0.62 - 0.4 * f) * s);
              g.beginPath();
              g.moveTo(ch.p[k - 1].x + -dy / d * wv * 0.5, ch.p[k - 1].y + dx / d * wv * 0.5);
              g.lineTo(ch.p[k].x + -dy / d * wv, ch.p[k].y + dx / d * wv);
              g.stroke();
            }
          }
        }

        // ---- the bell, in its own units; it tilts a little with the pulse
        wob = Math.sin(c.pp * TAU) * 0.05;
        place(g, c.x, c.y, c.a + wob, s);

        // glow flash after a click
        if (c.glow > 0.03) {
          g.fillStyle = b.core;
          g.globalAlpha = c.glow * 0.4;
          ell(g, 0.5, 0, sh.h * 1.6, sh.w * 1.5);
        }

        // rim, body, bright centre: three nested bells; the rim is the most solid, the middle is a see-through tint
        g.globalAlpha = 0.92;
        g.fillStyle = b.rim;
        bellPath(g, sh.w, sh.h, sh.lip, 0);
        g.fill();
        g.globalAlpha = 0.9;
        g.fillStyle = b.mid;
        bellPath(g, sh.w * 0.84, sh.h * 0.84, sh.lip * 0.8, 0.12);
        g.fill();
        g.globalAlpha = 0.85;
        g.fillStyle = b.core;
        bellPath(g, sh.w * 0.46, sh.h * 0.5, sh.lip * 0.3, 0.55);
        g.fill();

        // rim lobes and pearls along the edge
        g.globalAlpha = 0.95;
        g.fillStyle = b.rim;
        ell(g, -sh.lip, -sh.w, 0.55, 0.5);
        ell(g, -sh.lip, sh.w, 0.55, 0.5);
        g.fillStyle = b.spot;
        g.globalAlpha = 0.8;
        for (j = -2; j <= 2; j++) {
          w = j * sh.w * 0.34;
          dot(g, sh.h * (0.5 - 0.5 * Math.abs(j) / 2.4) + 0.2, w, 0.27);
        }
        // four small marks in the centre, like the gonads seen through a real bell
        g.globalAlpha = 0.55;
        g.fillStyle = b.mid;
        dot(g, sh.h * 0.34, -sh.w * 0.2, 0.34);
        dot(g, sh.h * 0.34, sh.w * 0.2, 0.34);
        g.globalAlpha = 1;
      }
    }
  };
})();
