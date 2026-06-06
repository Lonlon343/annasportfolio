/* ============================================================
   pennants.js — verlet wind-physics bunting (Wimpelketten)
   One chain per project. Real rope simulation: gravity + gusty
   wind + mouse push. DOM pennants (image-slots) ride the rope.
   ============================================================ */
(function () {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TRI = "polygon(0% 0%, 100% 0%, 50% 100%)"; // downward pennant

  // ---- tunables ----------------------------------------------------------
  const GRAVITY = 1500;     // px/s²
  const WIND_PX = 720;      // horizontal wind force scale (calmer)
  const DAMP = 0.972;       // more damping = settles faster, less shaky
  const ITER = 5;           // constraint relaxation passes
  const SLACK = 1.03;       // rope length vs straight distance (taut across wide spans)
  const MOUSE_R = 140;      // px radius of cursor push
  const MOUSE_F = 2400;     // cursor push force (gentler)

  // global gentle breeze value, roughly [-0.7, 1.0]
  function windAt(t, reduced) {
    let w =
      0.5 * Math.sin(t * 0.4) +
      0.28 * Math.sin(t * 0.17 + 1.7) +
      0.16 * Math.sin(t * 0.9 + 0.5);
    const gust = Math.pow(0.5 + 0.5 * Math.sin(t * 0.24 + 5.0), 2); // softer swells
    const strength = 0.4 + 0.45 * gust;
    w = w * strength + 0.22; // slight bias: drifts right
    return reduced ? w * 0.14 : w;
  }

  function PennantField(opts) {
    this.stage = document.querySelector(opts.stage);
    this.svg = document.querySelector(opts.svg);
    this.chainsCfg = opts.chains;
    this.onHover = opts.onHover || function () {};
    this.onMove = opts.onMove || function () {};
    this.onLeave = opts.onLeave || function () {};
    this.onClick = opts.onClick || function () {};
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.t = 0;
    this.acc = 0;
    this.mouse = { x: -1e4, y: -1e4, px: -1e4, py: -1e4, active: false };
    this.hovered = null;
    this.chains = [];

    this.buildDOM();
    this.layout(true);
    this.bind();

    this.last = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  PennantField.prototype.buildDOM = function () {
    const svgNS = "http://www.w3.org/2000/svg";
    this.chainsCfg.forEach((cfg, ci) => {
      // visible cord
      const line = document.createElementNS(svgNS, "polyline");
      line.setAttribute("class", "cord");
      line.setAttribute("data-chain", cfg.id);
      this.svg.appendChild(line);
      // fat invisible hit-area
      const hit = document.createElementNS(svgNS, "polyline");
      hit.setAttribute("class", "cord-hit");
      hit.setAttribute("data-chain", cfg.id);
      this.svg.appendChild(hit);

      const P = cfg.pennants.length;
      const N = P * 4 + 2; // rope nodes (denser = finer placement + smoother curve)

      const pennants = cfg.pennants.map((p, k) => {
        // even default spacing, or an explicit `at` fraction (0..1) for irregular hangs
        const frac = (typeof p.at === "number") ? p.at : ((k + 1) / (P + 1));
        const idx = Math.max(1, Math.min(N - 2, Math.round(frac * (N - 1))));
        const big = p.type === "img";
        const w = big ? (p.w || 116) : (p.w || 60);
        const h = big ? (p.h || 150) : (p.h || 86);

        const el = document.createElement("div");
        el.className = "pennant" + (big ? " is-img" : " is-deco");
        el.setAttribute("data-chain", cfg.id);
        el.style.width = w + "px";
        el.style.height = h + "px";

        const flutter = document.createElement("div");
        flutter.className = "flutter";

        if (big) {
          const slot = document.createElement("image-slot");
          slot.setAttribute("id", p.slot);
          slot.setAttribute("mask", TRI);
          slot.setAttribute("fit", "cover");
          slot.setAttribute("placeholder", p.placeholder || "Bild");
          if (p.src) slot.setAttribute("src", p.src);
          flutter.appendChild(slot);
        } else {
          const face = document.createElement("div");
          face.className = "face tone-" + (p.tone || "black");
          face.style.clipPath = TRI;
          flutter.appendChild(face);
        }
        const sheen = document.createElement("div");
        sheen.className = "sheen";
        sheen.style.clipPath = TRI;
        flutter.appendChild(sheen);

        el.appendChild(flutter);
        this.stage.appendChild(el);

        return {
          el, flutter, idx, w, h, big,
          phase: Math.random() * Math.PI * 2,
          fspeed: 6 + Math.random() * 3,
        };
      });

      const nodes = [];
      for (let i = 0; i < N; i++) {
        nodes.push({ x: 0, y: 0, px: 0, py: 0, noise: 0.7 + Math.random() * 0.6 });
      }

      this.chains.push({
        cfg, line, hit, nodes, pennants,
        chainPhase: ci * 1.7,
        seg: 10,
      });
    });
  };

  PennantField.prototype.layout = function (reset) {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    this.W = W; this.H = H;
    this.chains.forEach((ch) => {
      const a = ch.cfg.anchors[0];
      const b = ch.cfg.anchors[1];
      const ax = a.x * W, ay = a.y * H, bx = b.x * W, by = b.y * H;
      ch.ax = ax; ch.ay = ay; ch.bx = bx; ch.by = by;
      const D = Math.hypot(bx - ax, by - ay);
      ch.seg = (D * SLACK) / (ch.nodes.length - 1);
      if (reset) {
        const n = ch.nodes.length;
        for (let i = 0; i < n; i++) {
          const tt = i / (n - 1);
          // start on a gentle catenary-ish sag
          const sag = Math.sin(tt * Math.PI) * D * 0.06;
          const x = ax + (bx - ax) * tt;
          const y = ay + (by - ay) * tt + sag;
          ch.nodes[i].x = ch.nodes[i].px = x;
          ch.nodes[i].y = ch.nodes[i].py = y;
        }
      }
    });
  };

  PennantField.prototype.bind = function () {
    window.addEventListener("resize", () => this.layout(true));

    const move = (e) => {
      const r = this.stage.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.active = true;
      if (this.hovered) this.onMove(this.hovered, e.clientX, e.clientY);
    };
    this.stage.addEventListener("pointermove", move);
    this.stage.addEventListener("pointerleave", () => { this.mouse.active = false; });

    this.chains.forEach((ch) => {
      const enter = (e) => {
        this.hovered = ch.cfg.id;
        this.stage.classList.add("hovering");
        this.chains.forEach((c) =>
          c.pennants.forEach((p) => p.el.classList.toggle("dim", c !== ch))
        );
        ch.pennants.forEach((p) => p.el.classList.add("hot"));
        this.onHover(ch.cfg, e.clientX, e.clientY);
      };
      const leave = (e) => {
        if (this.hovered !== ch.cfg.id) return;
        // ignore leave when moving onto another element of the same chain
        if (e && e.relatedTarget && e.relatedTarget.closest &&
            e.relatedTarget.closest('[data-chain="' + ch.cfg.id + '"]')) return;
        this.hovered = null;
        this.stage.classList.remove("hovering");
        this.chains.forEach((c) =>
          c.pennants.forEach((p) => { p.el.classList.remove("dim"); p.el.classList.remove("hot"); })
        );
        this.onLeave();
      };
      const click = () => this.onClick(ch.cfg);
      ch._enter = enter; ch._leave = leave;

      // the cord itself
      ch.hit.addEventListener("pointerenter", enter);
      ch.hit.addEventListener("pointerleave", leave);
      ch.hit.addEventListener("click", click);
      ch.hit.style.cursor = "pointer";

      // every individual pennant on this chain is hoverable + clickable too
      ch.pennants.forEach((p) => {
        p.el.addEventListener("pointerenter", enter);
        p.el.addEventListener("pointerleave", leave);
        p.el.addEventListener("click", click);
      });
    });
  };

  PennantField.prototype.step = function (dt, t) {
    const w = windAt(t, this.reduced);
    const g = this.reduced ? GRAVITY * 0.6 : GRAVITY;
    const dt2 = dt * dt;
    const mActive = this.mouse.active;
    const mvx = this.mouse.x - this.mouse.px;
    const mvy = this.mouse.y - this.mouse.py;

    this.chains.forEach((ch) => {
      const nodes = ch.nodes;
      const n = nodes.length;
      for (let i = 1; i < n - 1; i++) {
        const nd = nodes[i];
        // travelling ripple along the rope (slower, shallower)
        const tw = 0.7 + 0.3 * Math.sin(t * 2.6 - i * 0.45 + ch.chainPhase);
        let ax = w * WIND_PX * tw * nd.noise;
        let ay = g + Math.sin(t * 3 - i * 0.5) * 45 * Math.abs(w);

        if (mActive) {
          const dx = nd.x - this.mouse.x;
          const dy = nd.y - this.mouse.y;
          const d = Math.hypot(dx, dy);
          if (d < MOUSE_R && d > 0.001) {
            const f = (1 - d / MOUSE_R) * MOUSE_F;
            ax += (dx / d) * f + mvx * 26;
            ay += (dy / d) * f + mvy * 26;
          }
        }
        const vx = (nd.x - nd.px) * DAMP;
        const vy = (nd.y - nd.py) * DAMP;
        nd.px = nd.x; nd.py = nd.y;
        nd.x += vx + ax * dt2;
        nd.y += vy + ay * dt2;
      }
      // pin endpoints
      nodes[0].x = ch.ax; nodes[0].y = ch.ay;
      nodes[0].px = ch.ax; nodes[0].py = ch.ay;
      nodes[n - 1].x = ch.bx; nodes[n - 1].y = ch.by;
      nodes[n - 1].px = ch.bx; nodes[n - 1].py = ch.by;

      // distance constraints
      for (let k = 0; k < ITER; k++) {
        for (let i = 0; i < n - 1; i++) {
          const a = nodes[i], b = nodes[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.0001;
          const diff = (d - ch.seg) / d;
          const ox = dx * 0.5 * diff;
          const oy = dy * 0.5 * diff;
          const aPin = i === 0;
          const bPin = i + 1 === n - 1;
          if (!aPin) { a.x += ox; a.y += oy; }
          if (!bPin) { b.x -= ox; b.y -= oy; }
          if (aPin && !bPin) { b.x -= ox * 2; b.y -= oy * 2; }
          if (bPin && !aPin) { a.x += ox * 2; a.y += oy * 2; }
        }
      }
    });
    this.mouse.px = this.mouse.x;
    this.mouse.py = this.mouse.y;
  };

  PennantField.prototype.render = function (t) {
    const w = windAt(t, this.reduced);
    this.chains.forEach((ch) => {
      const pts = ch.nodes.map((nd) => `${nd.x.toFixed(1)},${nd.y.toFixed(1)}`).join(" ");
      ch.line.setAttribute("points", pts);
      ch.hit.setAttribute("points", pts);

      ch.pennants.forEach((p) => {
        const nd = ch.nodes[p.idx];
        const vx = nd.x - nd.px;
        const tilt = clamp(
          -vx * 1.1 + w * 9 + 2 * Math.sin(t * (p.fspeed * 0.5) + p.phase),
          -22, 22
        );
        const sx = 1 - 0.07 * Math.abs(Math.sin(t * (p.fspeed * 0.5 + 1) + p.phase));
        const skew = 3 * Math.sin(t * (p.fspeed * 0.5 - 0.5) + p.phase * 1.3);
        p.el.style.transform =
          `translate(${(nd.x - p.w / 2).toFixed(1)}px, ${nd.y.toFixed(1)}px) rotate(${tilt.toFixed(2)}deg)`;
        p.flutter.style.transform = `scaleX(${sx.toFixed(3)}) skewX(${skew.toFixed(2)}deg)`;
      });
    });
  };

  PennantField.prototype.loop = function (now) {
    let frame = (now - this.last) / 1000;
    this.last = now;
    if (frame > 0.05) frame = 0.05; // clamp tab-away spikes
    this.acc += frame;
    const fixed = 1 / 60;
    let guard = 0;
    while (this.acc >= fixed && guard < 5) {
      this.t += fixed;
      this.step(fixed, this.t);
      this.acc -= fixed;
      guard++;
    }
    this.render(this.t);
    requestAnimationFrame(this.loop);
  };

  window.initPennants = function (opts) { return new PennantField(opts); };
})();
