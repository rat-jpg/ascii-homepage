/*!
 * rats.js - a rat scene for ascii-life.js.
 *
 * Load it after ascii-life.js. It registers AsciiLife.scenes.rat using the engine's own
 * helpers, so ascii-life.js itself stays unmodified:
 *
 *   <script src="ascii-life.js"></script>
 *   <script src="rats.js"></script>
 *   new AsciiLife(el, { scene: 'rat', palette: 'mix' }).start();
 *
 * Palettes (like the koi scene, a palette here is a breed):
 *   mix          every colour below, shuffled so each one shows up
 *   white        plain white
 *   gray         plain gray
 *   brown        plain brown
 *   calico       white with gray patches
 *   brownCalico  white with brown patches
 *   tricolor     white with gray and brown patches
 *
 * Drawn top-down like the koi and butterflies: forward is +x in the drawing units below,
 * one unit is about 2.7 grid cells at full size.
 */
(function () {
  'use strict';
  if (typeof AsciiLife === 'undefined' || !AsciiLife.scenes || !AsciiLife.helpers) return;

  var H = AsciiLife.helpers;
  var baseSpawn = H.baseSpawn, countOf = H.countOf, ext = H.ext, wrap = H.wrap, steer = H.steer;
  var separate = H.separate, scare = H.scare, shed = H.shed, splash = H.splash;
  var place = H.place, ell = H.ell, dot = H.dot;
  var PI = Math.PI, TAU = Math.PI * 2;

  var WHITE = '#f4f0e9', GRAY = '#797b82', BROWN = '#8d5d38';

  // base: coat colour. patches: colours of the patches on a calico coat (none = solid coat).
  // nose / ear / foot / tail: the pink skin parts, a little different per coat. eye: red on white.
  // shade: faint dorsal stripe on solid coats. face: lighter muzzle on solid coats.
  var BREEDS = [
    { name: 'white', base: WHITE, patches: [], nose: '#eaa0a4', ear: '#f2b6b3', foot: '#efb3ad', tail: '#f1b9b2',
      eye: '#8c2036', shade: '#d6d0c6', face: '#ffffff' },
    { name: 'gray', base: GRAY, patches: [], nose: '#d89c9f', ear: '#cba2a3', foot: '#c9a0a2', tail: '#c7a3a3',
      eye: '#0f1015', shade: '#5a5c63', face: '#9a9ca4' },
    { name: 'brown', base: BROWN, patches: [], nose: '#d8998c', ear: '#c79384', foot: '#cd9b8d', tail: '#cfa394',
      eye: '#0f1015', shade: '#6e4527', face: '#b3875f' },
    { name: 'calico', base: WHITE, patches: [GRAY], nose: '#eaa0a4', ear: '#f2b6b3', foot: '#efb3ad', tail: '#f1b9b2',
      eye: '#0f1015' },
    { name: 'brownCalico', base: WHITE, patches: [BROWN], nose: '#eaa0a4', ear: '#f2b6b3', foot: '#efb3ad', tail: '#f1b9b2',
      eye: '#0f1015' },
    { name: 'tricolor', base: WHITE, patches: [GRAY, BROWN], nose: '#eaa0a4', ear: '#f2b6b3', foot: '#efb3ad', tail: '#f1b9b2',
      eye: '#0f1015' }
  ];

  var TAIL_N = 28;     // tail segments: many short ones, so the tail reads as one smooth curve
  var TAIL_L = 0.31;   // length of one segment, drawing units (whole tail is about 8.7 units)
  var TAIL_WAVES = 1.0;  // S shapes along the tail: 1 = one full S, 1.5 = more of a ripple
  var TAIL_SWAY = 0.62;  // how far the S swings (radians of bend), at rest
  var TAIL_RUN = 0.3;    // extra swing while running
  var DUST = '#d8cdb8';

  // Patches for one calico rat, in drawing units: usually a hood over the head, sometimes a stripe
  // down the back, and a few blobs along the body. Tricolor alternates colours so both always appear.
  function makePatches(e, breed) {
    var cols = breed.patches, list = [], hood = null, off, n, k;
    if (!cols.length) return { list: list, hood: null };
    off = (e.rnd() * cols.length) | 0;
    if (e.rnd() < 0.72) {
      hood = cols[off];
      list.push({ x: 3.7 + e.rnd() * 0.8, y: (e.rnd() - 0.5) * 0.6, rx: 2.3 + e.rnd() * 1.2,
        ry: 1.9 + e.rnd() * 0.8, rot: 0, col: hood });
      if (e.rnd() < 0.5) {
        list.push({ x: -0.6 - e.rnd() * 0.8, y: (e.rnd() - 0.5) * 0.4, rx: 3.6 + e.rnd() * 1.2,
          ry: 0.55 + e.rnd() * 0.35, rot: 0, col: hood });
      }
    }
    n = 2 + ((e.rnd() * 3) | 0);
    for (k = 0; k < n; k++) {
      list.push({ x: -4.6 + e.rnd() * 6.4, y: (e.rnd() - 0.5) * 3.2, rx: 1.0 + e.rnd() * 1.4,
        ry: 0.8 + e.rnd() * 1.0, rot: e.rnd() * PI, col: cols[(k + off + 1) % cols.length] });
    }
    return { list: list, hood: hood };
  }

  // One closed path for the whole body, so it can be filled or used as a clip for the patches.
  function silhouette(g) {
    g.beginPath();
    g.moveTo(0.6, 0); g.ellipse(-2.3, 0, 2.9, 2.15, 0, 0, TAU);            // rump
    g.moveTo(3.0, 0); g.ellipse(0, 0, 3.0, 2.0, 0, 0, TAU);                // middle
    g.moveTo(4.2, 0); g.ellipse(1.9, 0, 2.3, 1.6, 0, 0, TAU);              // chest
    g.moveTo(5.65, 0); g.ellipse(3.9, 0, 1.75, 1.25, 0, 0, TAU);           // head
    g.moveTo(4.5, -1.1);                                                   // snout
    g.quadraticCurveTo(6.1, -0.6, 6.9, 0);
    g.quadraticCurveTo(6.1, 0.6, 4.5, 1.1);
    g.closePath();
  }

  AsciiLife.scenes.rat = {
    label: 'Rats', dot: '#d9c7b0', count: 9, palette: 'mix',
    scale: 2.0, minDepth: 0.5, reach: 14,
    palettes: {
      mix: { a: '#d9d3ca', ink: DUST },
      white: { a: WHITE, ink: DUST, breed: 0 },
      gray: { a: GRAY, ink: '#b4b6bd', breed: 1 },
      brown: { a: BROWN, ink: '#c9a37b', breed: 2 },
      calico: { a: GRAY, ink: DUST, breed: 3 },
      brownCalico: { a: BROWN, ink: DUST, breed: 4 },
      tricolor: { a: BROWN, ink: DUST, breed: 5 }
    },

    spawn: function (e) {
      var fixed = e.pal.breed, order = [], j, k, t, nb = BREEDS.length;
      // shuffled breed order, so with 6+ rats every colour shows up at least once
      for (j = 0; j < nb; j++) order.push(j);
      for (j = nb - 1; j > 0; j--) {
        k = (e.rnd() * (j + 1)) | 0;
        t = order[j]; order[j] = order[k]; order[k] = t;
      }
      e.items = baseSpawn(e, countOf(e, this.count), function (c, i) {
        var p;
        c.breed = fixed !== undefined ? fixed : order[i % nb];
        p = makePatches(e, BREEDS[c.breed]);
        c.pt = p.list;
        c.hood = p.hood;
        c.tc = 0;          // tail curl, eased so the tail lags behind turns
        c.tp = e.rnd() * TAU;   // phase of the S wave travelling down the tail
        c.go = 1;          // 0 = standing still, 1 = running
        c.gl = e.rnd() < 0.3 ? 0.3 + e.rnd() : 0;   // time left in a pause
      });
    },

    tapDefault: 'scare',
    taps: {
      // rats nearby bolt away from the click
      scare: function (e, x, y) {
        scare(e, x, y, 40 * e.unit, function (c, ang) {
          c.fl = 0.8 + e.rnd() * 0.6;
          c.fa = ang + (e.rnd() - 0.5) * 0.8;
          c.fk = 1;
          c.boost = 1;
          c.gl = 0;
        });
        splash(e, x, y, 1.5);
      }
    },

    update: function (e, dt) {
      var it = e.items, sp = e.o.speed, u = e.unit, m = ext(e, 14), i, c, k, v, wander, tcTarget;
      var en = e.o.energy === undefined ? 1 : e.o.energy;   // 0.4 calm .. 1.6 lively (the page's slider)
      for (i = 0; i < it.length; i++) {
        c = it[i];
        // quick, jerky turns while running; barely any while stopped to sniff
        wander = (Math.sin(e.t * 0.8 + c.o1) * 0.9 + Math.sin(e.t * 2.1 + c.o2) * 0.7) * sp * en * (c.gl > 0 ? 0.35 : 1);
        k = steer(e, c, dt, c.s * 16, wander, 6, 6);
        separate(e, c, dt, 5, 8 * u);
        c.boost *= Math.exp(-dt * 1.1);
        // run / stop-and-sniff rhythm; anything scary cancels a pause
        if (k > 0) c.gl = 0;
        if (c.gl > 0) c.gl -= dt * sp;
        else if (c.boost < 0.15 && e.rnd() < dt * 0.45 * sp * Math.max(0.2, 2 - en)) c.gl = 0.35 + e.rnd() * 1.1;
        c.go += ((c.gl > 0 ? 0 : 1) - c.go) * Math.min(1, dt * (c.gl > 0 ? 7 : 4));
        v = (11 + 5 * c.z) * u * sp * (0.8 + 0.2 * en) * (1 + 2 * c.boost) * c.go;
        c.x += Math.cos(c.a) * v * dt;
        c.y += Math.sin(c.a) * v * dt;
        // legs move with the ground speed, so the feet don't skate
        c.ph += dt * v / (c.s * 0.38);
        tcTarget = c.w * 0.25;
        if (tcTarget > 1.1) tcTarget = 1.1; else if (tcTarget < -1.1) tcTarget = -1.1;
        c.tc += (tcTarget - c.tc) * Math.min(1, dt * 5);
        // the S wave rolls down the tail slowly at rest and a little quicker when running
        c.tp += dt * (1.3 + 2.2 * c.go) * sp;
        wrap(e, c, m);
        // a little dust kicked up behind a rat that is running hard
        if (c.boost > 0.3) shed(e, c.x - Math.cos(c.a) * 3 * c.s, c.y - Math.sin(c.a) * 3 * c.s, 0.08 * c.boost, dt);
      }
    },

    draw: function (e, g) {
      var it = e.items, P = e.pal, i, j, c, s, b, sd, f, h, hx, hy, nx, ny, w, tw, p, ph1, ph2;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (i = 0; i < it.length; i++) {
        c = it[i];
        s = c.s;
        b = BREEDS[P.breed === undefined ? c.breed : P.breed];
        g.globalAlpha = 1;
        // a slight waddle in time with the stride
        place(g, c.x, c.y, c.a + Math.sin(c.ph) * 0.05 * c.go, s);

        // tail: a flowing S. The bend angle follows a sine wave along the tail (small at the root,
        // bigger toward the tip) that rolls toward the tip over time, plus a lean away from the turn.
        g.strokeStyle = b.tail;
        hx = -4.7; hy = 0;
        w = TAIL_SWAY + TAIL_RUN * c.go;
        for (j = 0; j < TAIL_N; j++) {
          f = (j + 0.5) / TAIL_N;                                   // 0 at the root, 1 at the tip
          h = PI + c.tc * f +
            w * (0.22 + 0.78 * f) * Math.sin(TAU * TAIL_WAVES * f - c.tp) +
            Math.sin(e.t * 0.9 + c.o2) * 0.08 * f;                  // a slow extra drift so it never repeats exactly
          nx = hx + Math.cos(h) * TAIL_L;
          ny = hy + Math.sin(h) * TAIL_L;
          g.lineWidth = 0.66 - 0.5 * f;
          g.beginPath();
          g.moveTo(hx, hy);
          g.lineTo(nx, ny);
          g.stroke();
          hx = nx; hy = ny;
        }

        // feet: diagonal pairs move together
        g.fillStyle = b.foot;
        for (sd = -1; sd <= 1; sd += 2) {
          ph1 = c.ph + (sd > 0 ? 0 : PI);
          ph2 = c.ph + (sd > 0 ? PI : 0);
          ell(g, 2.5 + Math.sin(ph1) * 0.95 * c.go, sd * 2.0, 0.7, 0.42, sd * 0.35);
          ell(g, -3.5 + Math.sin(ph2) * 1.2 * c.go, sd * 2.35, 1.05, 0.5, -sd * 0.25);
        }

        // body
        g.fillStyle = b.base;
        silhouette(g);
        g.fill();
        if (c.pt.length) {
          g.save();
          silhouette(g);
          g.clip();
          for (j = 0; j < c.pt.length; j++) {
            p = c.pt[j];
            g.fillStyle = p.col;
            ell(g, p.x, p.y, p.rx, p.ry, p.rot);
          }
          g.restore();
        } else {
          g.globalAlpha = 0.3;
          g.fillStyle = b.shade;
          ell(g, -0.8, 0, 4.4, 0.55);
          g.globalAlpha = 0.55;
          g.fillStyle = b.face;
          ell(g, 5.3, 0, 1.3, 0.62);
          g.globalAlpha = 1;
        }

        // ears: hair on the outside, pink inside
        for (sd = -1; sd <= 1; sd += 2) {
          g.fillStyle = c.hood || b.base;
          ell(g, 3.0, sd * 1.5, 0.95, 0.85);
          g.fillStyle = b.ear;
          ell(g, 3.1, sd * 1.5, 0.55, 0.5);
        }

        // eyes and nose
        g.fillStyle = b.eye;
        dot(g, 4.55, -0.62, 0.27);
        dot(g, 4.55, 0.62, 0.27);
        g.fillStyle = b.nose;
        dot(g, 6.8, 0, 0.42);

        // whiskers, twitching faster when the rat has stopped to sniff
        tw = Math.sin(e.t * 16 + c.o1) * (c.gl > 0 ? 0.14 : 0.05);
        g.strokeStyle = '#efe8da';
        g.lineWidth = 0.17;
        g.globalAlpha = 0.65;
        g.beginPath();
        for (sd = -1; sd <= 1; sd += 2) {
          g.moveTo(6.0, sd * 0.28); g.lineTo(7.7, sd * 1.45 + tw);
          g.moveTo(6.1, sd * 0.12); g.lineTo(8.0, sd * 0.6 + tw);
          g.moveTo(5.9, sd * 0.38); g.lineTo(7.2, sd * 2.0 + tw);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
    }
  };
})();
