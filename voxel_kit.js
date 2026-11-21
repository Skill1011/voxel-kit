/*
 * Voxel Figure Kit: build Roblox figures out of hundreds of small, slightly tilted blocks and export them.
 *
 *   const fig = new VoxelKit.Figure('ZombieChef', { seed: 7, jitter: 10 });
 *   fig.chunk('Head', [0, 1.6, 0], [2.8, 3.0, 1.8], VoxelKit.ramp('#708b53'));
 *   fig.mirror('R');                       // copy every ...R part to ...L
 *   fig.toRbxmx()  -> string  (.rbxmx, drag into Roblox Studio, Parts only, no scripts)
 *   fig.toGLB()    -> Uint8Array (.glb, one mesh per body part, pivot at the joint)
 *   fig.toJSON()   -> plain object (the build, for re-editing)
 *
 * Coordinates: 1 unit = 1 Roblox stud, Y up, the figure FACES -Z, its right side is +X, feet stand on y = 0.
 * Every voxel belongs to a body part. Positions you pass are RELATIVE TO THAT PART'S JOINT unless { abs: true }.
 * Works in a browser (<script>) and in Node (require). No dependencies.
 */
(function (root, factory) {
	const kit = factory();
	if (typeof module === 'object' && module.exports) module.exports = kit;
	else root.VoxelKit = kit;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// The reference rig (measured from a set of 9 hand-built voxel zombies). scale 1 = top of head at ~16 studs.
	const SKELETON = {
		Pelvis: { joint: [0, 8.3, 0], parent: null },
		Torso: { joint: [0, 8.65, 0], parent: 'Pelvis' },
		Head: { joint: [0, 12.65, 0], parent: 'Torso' },
		Jaw: { joint: [0, 13.85, -0.04], parent: 'Head' },
		UpperR: { joint: [2.16, 11.99, 0], parent: 'Torso' },
		ForeR: { joint: [2.38, 9.63, 0], parent: 'UpperR' },
		HandR: { joint: [2.42, 7.35, 0], parent: 'ForeR' },
		UpperL: { joint: [-2.16, 11.99, 0], parent: 'Torso' },
		ForeL: { joint: [-2.38, 9.63, 0], parent: 'UpperL' },
		HandL: { joint: [-2.42, 7.35, 0], parent: 'ForeL' },
		ThighR: { joint: [1.17, 8.12, 0], parent: 'Pelvis' },
		ShinR: { joint: [1.17, 5.03, 0], parent: 'ThighR' },
		BootR: { joint: [1.17, 2.0, 0], parent: 'ShinR' },
		ThighL: { joint: [-1.17, 8.12, 0], parent: 'Pelvis' },
		ShinL: { joint: [-1.17, 5.03, 0], parent: 'ThighL' },
		BootL: { joint: [-1.17, 2.0, 0], parent: 'ShinL' },
	};

	// A four-legged creature (dog, wolf, cat, lizard, bug body...). Faces -Z, back at ~5 studs. Scale it with toRbxmx({scale}).
	const QUADRUPED = {
		Body: { joint: [0, 3.4, 0], parent: null },
		Neck: { joint: [0, 4.0, -1.6], parent: 'Body' },
		Head: { joint: [0, 4.6, -2.3], parent: 'Neck' },
		Jaw: { joint: [0, 4.3, -2.6], parent: 'Head' },
		Tail: { joint: [0, 3.9, 1.9], parent: 'Body' },
		FrontLegR: { joint: [0.85, 2.9, -1.3], parent: 'Body' },
		FrontPawR: { joint: [0.85, 0.9, -1.3], parent: 'FrontLegR' },
		BackLegR: { joint: [0.85, 2.9, 1.3], parent: 'Body' },
		BackPawR: { joint: [0.85, 0.9, 1.3], parent: 'BackLegR' },
		FrontLegL: { joint: [-0.85, 2.9, -1.3], parent: 'Body' },
		FrontPawL: { joint: [-0.85, 0.9, -1.3], parent: 'FrontLegL' },
		BackLegL: { joint: [-0.85, 2.9, 1.3], parent: 'Body' },
		BackPawL: { joint: [-0.85, 0.9, 1.3], parent: 'BackLegL' },
	};
	const PRESETS = { humanoid: SKELETON, zombie: SKELETON, quadruped: QUADRUPED, none: {} };

	// Roblox Enum.Material values used by this style.
	const MATERIALS = { Plastic: 256, SmoothPlastic: 272, Neon: 288, Wood: 512, Metal: 1088, Fabric: 1312, Glass: 1568 };
	const SHAPES = { Block: 1, Cylinder: 2 };

	// ---------- small helpers ----------
	function mulberry32(seed) {
		let a = seed >>> 0;
		return function () {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	function toRGB(c) {
		if (Array.isArray(c)) return c.map(v => Math.max(0, Math.min(255, Math.round(v))));
		let h = String(c).replace('#', '');
		if (h.length === 3) h = h.split('').map(x => x + x).join('');
		const n = parseInt(h, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	function toHex(rgb) { return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''); }
	/** Shading ramp of one colour: [highlight, mid, shadow, deep]. The style shades every material in 3-4 tones. */
	function ramp(c, spread) {
		const k = spread || 1;
		const rgb = toRGB(c);
		return [1 + 0.22 * k, 1, 1 - 0.24 * k, 1 - 0.48 * k].map(f => toHex(rgb.map(v => Math.min(255, Math.round(v * f)))));
	}
	/** 4 close variants of one neon colour (the reference never uses one flat neon tone: #9aff0c, #8def0d, #72ef0d...). */
	function neonRamp(c) {
		const rgb = toRGB(c);
		return [[1, 1, 1], [0.92, 0.95, 1.05], [0.78, 0.93, 1.0], [0.72, 0.72, 0.85]].map(f => toHex(rgb.map((v, i) => Math.min(255, Math.round(v * f[i])))));
	}
	const D2R = Math.PI / 180;
	/** Rotation matrix (row-major 3x3) for Euler angles in degrees, same order as Roblox CFrame.Angles(rx, ry, rz). */
	function euler(rx, ry, rz) {
		const [a, b, c] = [rx * D2R, ry * D2R, rz * D2R];
		const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
		// Rx * Ry * Rz
		return [
			cb * cc, -cb * sc, sb,
			sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
			-ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb,
		];
	}
	function mulM(A, B) {
		const r = new Array(9);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
		return r;
	}
	/** Rotation matrix about a unit axis (x,y,z) by angle a (radians). */
	function axisAngle(x, y, z, a) {
		const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
		return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
	}
	/** The single rotation that turns direction a into direction b (both unit vectors). */
	function fromTo(a, b) {
		const ax = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
		const s = Math.hypot(...ax), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
		return axisAngle(ax[0] / s, ax[1] / s, ax[2] / s, Math.atan2(s, c));
	}
	function mulV(R, v) { return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]]; }
	const f4 = x => +(+x).toFixed(4);

	// ---------- the figure ----------
	class Figure {
		/**
		 * @param {string} name   model name in Studio
		 * @param {object} opts   { seed: number, jitter: degrees of random tilt per voxel (default 10),
		 *                          skeleton: 'humanoid' (default) | 'quadruped' | 'none' (props: add your own parts with addPart) }
		 */
		constructor(name, opts) {
			this.name = name || 'VoxelFigure';
			// straight: share of blocks without any random tilt (reference: ~35 % exactly aligned with their body part)
			this.opts = Object.assign({ seed: 1, jitter: 14, straight: 0.3, skeleton: 'humanoid' }, opts || {});
			this.rnd = mulberry32(this.opts.seed);
			this.parts = {}; // name -> { joint, parent }
			this.voxels = [];
			const preset = PRESETS[this.opts.skeleton];
			if (!preset) throw new Error('Unknown skeleton ' + this.opts.skeleton + ' (humanoid, quadruped, none)');
			for (const k in preset) this.parts[k] = { joint: preset[k].joint.slice(), parent: preset[k].parent };
		}
		/** random number in [a, b) from the figure's seeded generator, so the same code always builds the same figure */
		rand(a, b) { return a + (b - a) * this.rnd(); }
		pick(list) { return list[Math.floor(this.rnd() * list.length)]; }

		/**
		 * Add or move a body part: an accessory that should swing on its own (hat tip, lantern, tail, sack, lid), or armour that
		 * must NOT turn with a limb when you pose it (a shoulder plate is its own part with parent 'Torso', not voxels on UpperR).
		 * @param parent  parent part name; null for a root part (props). Default 'Torso'.
		 * @param o       { sway: false } stops the preview's idle wobble for this part (armour, plates, fixed props)
		 */
		addPart(name, joint, parent, o) {
			this.parts[name] = { joint: joint.slice(), parent: parent === undefined ? 'Torso' : parent };
			if (o && o.sway === false) this.parts[name].sway = false;
			return this;
		}
		joint(part) {
			const p = this.parts[part];
			if (!p) throw new Error('Unknown body part "' + part + '". Add it with addPart(name, joint, parent).');
			return p.joint;
		}

		/**
		 * One block.
		 * @param part   body part name
		 * @param pos    centre [x,y,z], relative to the part's joint (or absolute with {abs:true})
		 * @param size   [sx,sy,sz] in studs
		 * @param color  '#rrggbb' or [r,g,b]
		 * @param o      { rot:[rx,ry,rz] deg, jitter: max random tilt in deg (0 = perfectly straight), mat:'SmoothPlastic'|'Neon'|'Glass'|...,
		 *                 t: transparency, shape:'Block'|'Cylinder' (cylinder axis = X, diameter = min(sy,sz)), name: 'Voxel' }
		 * The random tilt turns about ONE axis only (mostly the block's thinnest axis, so plates spin flat in their surface),
		 * and about a third of all blocks stay straight. Measured on the reference: 86 % of tilted blocks turn about a single axis.
		 * Tilting every block about all three axes at once makes corners poke out and the model looks broken.
		 */
		box(part, pos, size, color, o) {
			o = o || {};
			const j = this.joint(part);
			const p = o.abs ? pos.slice() : [pos[0] + j[0], pos[1] + j[1], pos[2] + j[2]];
			const jit = o.jitter === undefined ? this.opts.jitter : o.jitter;
			const r = o.rot || [0, 0, 0];
			const R = mulM(euler(r[0], r[1], r[2]), this.tilt(size, jit, o.tiltAxis));
			const mat = o.mat || 'SmoothPlastic';
			if (!(mat in MATERIALS)) throw new Error('Unknown material ' + mat);
			const v = {
				part, p, s: size.map(x => Math.max(0.02, Math.abs(x))), R, c: toRGB(color), mat,
				t: o.t || 0, shape: o.shape || 'Block', name: o.name || (mat === 'Neon' ? 'Glow' : 'Voxel'),
			};
			this.voxels.push(v);
			return v;
		}

		/**
		 * Random tilt for one block: identity for ~35 % (opts.straight), otherwise a turn about ONE local axis.
		 * Half the time that is the thinnest axis (a plate spins flat in its own surface, nothing pokes out),
		 * otherwise one of the other axes with half the angle (a gentle lift of one edge).
		 */
		tilt(size, jit, axis) {
			if (!jit || this.rnd() < this.opts.straight) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
			const thin = size ? size.indexOf(Math.min(...size)) : 2;
			let ax = axis, k = 1;
			if (ax === undefined) { if (this.rnd() < 0.5) ax = thin; else { ax = [0, 1, 2].filter(i => i !== thin)[this.rnd() < 0.5 ? 0 : 1]; k = 0.5; } }
			const a = (this.rnd() < 0.5 ? -1 : 1) * this.rand(0.3, 1) * jit * k;
			return euler(ax === 0 ? a : 0, ax === 1 ? a : 0, ax === 2 ? a : 0);
		}

		/**
		 * A hand-sculpted block: a straight core plus flat panels laid on its faces in neighbouring shades, like patches of cloth,
		 * plates of armour or chips of stone. Panels lie flush and only spin within their face (plus a slight lift now and then).
		 * This is the workhorse of the style: heads, torsos, boots and hands are mostly 1-3 chunks plus details.
		 * @param colors  a ramp (array); colors[1] is the core, the others are used for the panels
		 * @param o       { bumps: number of panels (default from size), skipBottom: true, jitter (panel spin, default figure jitter),
		 *                  maxPlate: 1.2, rot, mat, coreJitter: 0 }
		 */
		chunk(part, pos, size, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const core = this.box(part, pos, size, cols[Math.min(1, cols.length - 1)], { rot: o.rot, jitter: o.coreJitter || 0, mat: o.mat, abs: o.abs });
			const area = size[0] * size[1] + size[1] * size[2] + size[0] * size[2];
			const n = o.bumps === undefined ? Math.max(3, Math.round(area * 1.3)) : o.bumps;
			const maxPlate = o.maxPlate || 0.7;
			const jit = o.jitter === undefined ? this.opts.jitter : o.jitter;
			const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
			if (!o.skipBottom) faces.push([0, -1, 0]);
			for (let i = 0; i < n; i++) {
				const f = this.pick(faces);
				const ax = f[0] ? 0 : f[1] ? 1 : 2;
				// thin "painted" tiles like the reference (0.06 thick, 0.14-0.6 wide), sitting flush on the face
				const s = size.map((d, k) => (k === ax ? this.rand(0.05, 0.09) : Math.min(maxPlate, d * 0.8, this.rand(0.16, 0.6))));
				const local = size.map((d, k) => (k === ax ? (f[k] * (d / 2 + s[k] * 0.3)) : this.rand(-d / 2 + s[k] / 2, d / 2 - s[k] / 2)));
				const off = mulV(core.R, local);
				const c = cols.length > 1 ? this.pick(cols) : cols[0];
				const v = this.box(part, [core.p[0] + off[0], core.p[1] + off[1], core.p[2] + off[2]], s, c, { abs: true, jitter: 0, mat: o.mat });
				// spin flat in the face (axis = face normal); rarely lift an edge a little
				let T = [1, 0, 0, 0, 1, 0, 0, 0, 1];
				if (jit && this.rnd() > this.opts.straight) {
					const lift = this.rnd() < 0.25, a = (this.rnd() < 0.5 ? -1 : 1) * this.rand(0.3, 1) * jit * (lift ? 0.35 : 1);
					const tax = lift ? [0, 1, 2].filter(q => q !== ax)[this.rnd() < 0.5 ? 0 : 1] : ax;
					T = euler(tax === 0 ? a : 0, tax === 1 ? a : 0, tax === 2 ? a : 0);
				}
				v.R = mulM(core.R, T);
			}
			return core;
		}

		/**
		 * Thin painted tiles on ONE face (wrinkles, fabric weave, rust, moss, freckles, scales) without adding bulk.
		 * @param center centre of the face area (relative to the joint), already ON the surface
		 * @param size   [width, height] of the area on that face
		 * @param o      { face: '-Z'|'+Z'|'-X'|'+X'|'+Y', count (default from area), tile: [0.12, 0.42], depth: 0.06, jitter: 6 (spin in the face only) }
		 */
		texture(part, center, size, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const [W, H] = size, d = o.depth || 0.06, face = o.face || '-Z';
			const n = o.count || Math.max(2, Math.round(W * H * 4));
			const [tmin, tmax] = o.tile || [0.12, 0.42];
			const nax = face.endsWith('X') ? 0 : face === '+Y' ? 1 : 2, sg = face[0] === '+' ? 1 : -1;
			for (let i = 0; i < n; i++) {
				const tw = Math.min(W, this.rand(tmin, tmax)), th = Math.min(H, this.rand(tmin, tmax) * this.rand(0.5, 1));
				const u = this.rand(-W / 2 + tw / 2, W / 2 - tw / 2), v = this.rand(-H / 2 + th / 2, H / 2 - th / 2);
				const p = center.slice(), s = [0, 0, 0];
				if (nax === 2) { p[0] += u; p[1] += v; s[0] = tw; s[1] = th; }
				else if (nax === 0) { p[2] += u; p[1] += v; s[2] = tw; s[1] = th; }
				else { p[0] += u; p[2] += v; s[0] = tw; s[2] = th; }
				p[nax] += sg * d / 2; s[nax] = d;
				this.box(part, p, s, this.pick(cols), { jitter: o.jitter === undefined ? 12 : o.jitter, tiltAxis: nax });
			}
		}

		// ---------- body-part builders: clean, readable anatomy like the reference ----------
		/**
		 * A chunky hand hanging down from its joint: a big palm block, a two-piece thumb on the inner side and 3 (or 4) fingers
		 * of two segments each, the tips one shade lighter and curled forwards. Reference hand: 9 blocks, palm ~1.9 x 1.3 x 1.5.
		 * Build it on the R side and mirror; on the L side directly it detects the side from the name.
		 * @param o { colors: ramp (default zombie green), fingers: 3, curl: 0.5 (0 straight .. 1 claw), scale: 1, at: palm centre,
		 *            nails: colour or null, claws: true (pointed nails), glove: colour for the palm (gloves/mittens) }
		 */
		hand(part, o) {
			o = o || {};
			const sc = o.scale || 1, col = o.colors || ramp('#708b53'), nf = o.fingers || 3;
			const curl = o.curl === undefined ? 0.5 : o.curl, side = part.endsWith('L') ? -1 : 1;
			const palm = [1.8 * sc, 1.3 * sc, 1.5 * sc], pc = o.at || [0, -0.65 * sc, -0.1 * sc];
			this.box(part, pc, palm, o.glove || col[1], { jitter: 0 });
			this.box(part, [pc[0], pc[1] + palm[1] * 0.18, pc[2] + palm[2] / 2 + 0.03], [palm[0] * 0.7, palm[1] * 0.5, 0.06], col[2], { jitter: 0 }); // back of the hand
			const step = palm[0] / nf, fw = step * 0.82;
			for (let i = 0; i < nf; i++) {
				const x = pc[0] - palm[0] / 2 + step * (i + 0.5);
				const y1 = pc[1] - palm[1] / 2 - 0.38 * sc, z1 = pc[2] - 0.12 * sc;
				this.box(part, [x, y1, z1], [fw, 0.82 * sc, 0.58 * sc], col[1], { jitter: 0, rot: [curl * 12, 0, 0] });
				const y2 = y1 - 0.62 * sc, z2 = z1 - 0.3 * sc * (0.4 + curl);
				this.box(part, [x, y2, z2], [fw * 0.94, 0.58 * sc, 0.52 * sc], col[0], { jitter: 0, rot: [curl * 35, 0, 0] });
				if (o.nails !== null) {
					const nc = o.nails || '#cfd3e2';
					this.box(part, [x, y2 - 0.3 * sc, z2 - 0.18 * sc * (0.3 + curl)], [fw * (o.claws ? 0.5 : 0.7), (o.claws ? 0.34 : 0.16) * sc, 0.26 * sc], nc, { jitter: 0, rot: [curl * 50, 0, 0] });
				}
			}
			const tx = pc[0] - side * (palm[0] / 2 + 0.06 * sc);
			this.box(part, [tx, pc[1] - 0.05 * sc, pc[2] - 0.28 * sc], [0.52 * sc, 0.72 * sc, 0.52 * sc], col[1], { jitter: 0 });
			this.box(part, [tx - side * 0.12 * sc, pc[1] - 0.44 * sc, pc[2] - 0.56 * sc], [0.47 * sc, 0.45 * sc, 0.47 * sc], col[0], { jitter: 0, rot: [0, 0, side * 12] });
		}

		/**
		 * The reference boot, standing on y = 0 with the default joint: three stacked tiers (shaft 2.06 x 1.59 x 1.99,
		 * foot 2.22 x 1.16 x 2.52, sole 2.36 x 0.46 x 2.74), optional coloured top band, toe cap and laces.
		 * @param o { colors: ramp (shaft, foot, sole from it), band: colour or null, toes: 0 (number of small toe caps),
		 *            toeCap: colour, laces: colour, scale: 1, x: 0.1, z: depth of the shaft centre (default 0.15) }
		 */
		boot(part, o) {
			o = o || {};
			const sc = o.scale || 1, col = o.colors || ramp('#3a2c26'), z = o.z === undefined ? 0.15 : o.z;
			const x = o.x === undefined ? (part.endsWith('L') ? -0.1 : 0.1) : o.x;
			const B = (p, s, c, q) => this.box(part, [p[0], p[1] * sc, p[2]], s.map(v => v * sc), c, Object.assign({ jitter: 0 }, q || {}));
			B([x, -0.6, z], [2.06, 1.59, 1.99], col[1]);
			B([x, -1.18, z - 0.3], [2.22, 1.16, 2.52], col[2] || col[1]);
			B([x, -1.72, z - 0.3], [2.36, 0.46, 2.74], col[3] || col[2] || col[1]);
			if (o.band) B([x, 0.12, z], [2.12, 0.3, 2.05], o.band);
			if (o.toeCap) B([x, -1.25, z - 1.52], [1.7, 0.7, 0.14], o.toeCap);
			const n = o.toes || 0;
			for (let i = 0; i < n; i++) B([x - 1.0 + (i + 0.5) * 2.0 / n, -1.5, z - 1.6], [2.0 / n * 0.85, 0.3, 0.3], col[0]);
			if (o.laces) for (let i = 0; i < 3; i++) B([x, -0.2 - i * 0.32, z - 1.02], [1.1, 0.09, 0.08], o.laces, { rot: [0, 0, i % 2 ? 14 : -14] });
		}

		/**
		 * The shared base body of the reference (all 9 reference zombies use exactly this): thick limbs, a wide torso, three-tier
		 * boots, plus clothing layers on top. Builds BOTH sides (no mirror needed) and returns the important surfaces so you
		 * can add clothes, belts, badges and wounds on them. Call it first, then add details, then pose.
		 * Measured: upper arm 1.62 x 2.63 x 1.66 + shoulder 1.88 x 1.14 x 1.95, forearm 1.54 x 2.3 x 1.53 + cuff 1.76 x 1.48 x 1.78,
		 * thigh 1.84 x 3.07 x 1.94, shin 1.66 x 3.09 x 1.71 + trouser cuff 1.86 x 1.88 x 1.8, pelvis 4.28 x 1.6 x 2.34 + belt 4.58 x 0.61,
		 * torso 4.45 x 3.87 x 2.51.
		 * @param o {
		 *   skin: ramp [hi, mid, lo, deep] (default zombie green),
		 *   top: ramp for torso, shoulders, sleeves (shirt / jacket / coat), topFront: lighter front colour (default top[0]),
		 *   sleeves: 'rolled' (skin forearm + cuff, default) | 'long' | 'bare',
		 *   pants: ramp, legs: 'torn' (skin shin below a torn cuff, default) | 'long' | 'bare',
		 *   hole: true (a torn hole in the trousers showing skin on the right thigh), belt: colour or null, buckle: colour,
		 *   boots: ramp, bootBand: colour, laces: colour, hands: options for hand(), z0: 0.15,
		 *   detail: 'rich' (default: torn sleeve ring, painted skin and fabric tiles front/back/sides) | 'plain', rags: false (no sleeve ring) }
		 * @returns { z0, torsoFront, pelvisFront, shoulderTop } (torsoFront = z just in front of the front panels)
		 */
		body(o) {
			o = o || {};
			const skin = o.skin || ramp('#708b53'), top = o.top || ramp('#5a4a6a'), pants = o.pants || ramp('#3d3a52');
			const z0 = o.z0 === undefined ? 0.15 : o.z0, first = this.voxels.length;
			const B = (part, p, s, c, q) => this.box(part, p, s, c, Object.assign({ jitter: 0 }, q || {}));
			for (const side of ['R', 'L']) {
				const k = side === 'R' ? 1 : -1, X = x => x * k;
				B('Upper' + side, [X(0.3), -1.25, 0.05], [1.62, 2.63, 1.66], o.sleeves === 'bare' ? skin[1] : top[1]);
				B('Upper' + side, [X(0.15), -0.3, 0.05], [1.88, 1.14, 1.95], top[2]);
				B('Fore' + side, [X(0.15), -1.15, 0], [1.54, 2.3, 1.53], o.sleeves === 'long' ? top[1] : skin[1]);
				if (o.sleeves !== 'bare') B('Fore' + side, [X(0.15), -0.55, 0], [1.76, 1.48, 1.78], top[2]);
				this.hand('Hand' + side, Object.assign({ colors: skin, fingers: 3, curl: 0.55, scale: 1.1, nails: '#d8cfa8' }, o.hands || {}));
				B('Thigh' + side, [X(0.05), -1.6, z0], [1.84, 3.07, 1.94], o.legs === 'bare' ? skin[1] : pants[1]);
				B('Shin' + side, [X(0.05), -1.5, z0], [1.66, 3.09, 1.71], o.legs === 'long' ? pants[1] : skin[2]);
				if (o.legs !== 'bare') {
					B('Shin' + side, [X(0.05), -0.95, z0], [1.86, 1.95, 1.84], pants[2]);
					if (o.legs !== 'long') this.fringe('Shin' + side, [X(-0.85), -1.9, z0 - 0.93], [X(0.95), -1.9, z0 - 0.93], 5, [0.15, 0.45], [pants[2], pants[3]], { thick: 0.12 });
				}
				this.boot('Boot' + side, { colors: o.boots || ramp('#3a2c26'), band: o.bootBand, laces: o.laces, x: X(0.1), z: z0 });
			}
			if (o.hole !== false && o.legs !== 'bare') {
				B('ThighR', [0.15, -1.7, z0 - 0.98], [1.0, 1.1, 0.1], skin[1]);
				for (const [x, y] of [[-0.35, -1.15], [0.65, -1.2], [-0.35, -2.25], [0.7, -2.2], [0.15, -1.1], [0.2, -2.3]])
					this.box('ThighR', [x, y, z0 - 1.0], [0.32, 0.26, 0.08], pants[3], { jitter: 20, tiltAxis: 2 });
			}
			B('Pelvis', [0, -0.38, z0], [4.28, 1.6, 2.34], pants[1]);
			if (o.belt !== null) B('Pelvis', [0, 0.11, z0], [4.58, 0.61, 2.53], o.belt || '#2a2626');
			if (o.buckle) B('Pelvis', [0, 0.11, z0 - 1.3], [0.62, 0.48, 0.1], o.buckle);
			B('Torso', [0, 1.64, z0], [4.45, 3.87, 2.51], top[1]);
			const fz = z0 - 1.255;
			for (const s of [1, -1]) B('Torso', [s * 1.45, 1.56, fz - 0.05], [1.35, 3.63, 0.4], o.topFront || top[0]);
			// detail layer of the reference: rings / rows of equal pieces and thin painted tiles (o.detail: 'plain' switches it off)
			if (o.detail !== 'plain') {
				for (const side of ['R', 'L']) {
					const k = side === 'R' ? 1 : -1, X = x => x * k;
					if (o.sleeves !== 'bare' && o.rags !== false) this.collar('Upper' + side, [X(0.3), -1.0, 0.05], [0.92, 0.92], 7, [top[1], top[2], top[0]], { arc: 1, size: [0.44, 1.05, 0.62], jitter: 18 });
					if (o.sleeves !== 'long') this.texture('Fore' + side, [X(0.15), -1.55, -0.77], [1.2, 1.1], skin, { face: '-Z', count: 5 });
					if (o.legs !== 'long' && o.legs !== 'bare') this.texture('Shin' + side, [X(0.05), -2.45, z0 - 0.86], [1.3, 0.9], skin, { face: '-Z', count: 4 });
					if (o.legs !== 'bare') this.texture('Thigh' + side, [X(0.05), -0.8, z0 - 0.97], [1.5, 0.9], [pants[0], pants[2]], { face: '-Z', count: 4 });
					if (o.legs === 'long') this.collar('Boot' + side, [X(0.1), 0.1, z0], [1.05, 1.0], 8, [pants[1], pants[2]], { arc: 1, size: [0.39, 0.78, 0.49], jitter: 14 });
				}
				for (const s of [1, -1]) this.texture('Torso', [s * 1.45, 1.1, fz - 0.25], [1.1, 2.4], [o.topFront || top[0], top[1]], { face: '-Z', count: 5 });
				this.texture('Torso', [0, 1.7, z0 + 1.255], [3.8, 3.2], [top[1], top[2]], { face: '+Z', count: 9 });            // back
				for (const s of [1, -1]) this.texture('Torso', [s * 2.225, 1.7, z0], [2.0, 3.0], [top[1], top[2]], { face: s > 0 ? '+X' : '-X', count: 4 });
				this.texture('Pelvis', [0, -0.55, z0 - 1.17], [3.6, 0.8], [pants[0], pants[2]], { face: '-Z', count: 5 });
			}
			for (let i = first; i < this.voxels.length; i++) this.voxels[i].mirrored = true;   // mirror('R') must not copy these again
			return { z0, torsoFront: fz - 0.25, pelvisFront: z0 - 1.17, shoulderTop: 8.65 + 1.64 + 1.94 };
		}

		/**
		 * A head modelled like the reference: a skull in the side colour, lit front planes (forehead, nose bridge, cheekbones)
		 * one shade LIGHTER, dark brow ridges over very dark sockets with small (glowing) eyes, nose tip, lower cheeks, ears,
		 * neck, a mouth (open with an even row of teeth, or a closed dark line with a lip). Front = -Z.
		 * @param o { skin: ramp [hi, mid, lo, deep], front: colour for the lit planes (default lighter than hi),
		 *            expression: 'angry' | 'neutral' | 'grin', eyes: colour, glow: true, eyeStyle: 'glow' | 'human' (white eye + pupil),
		 *            mouth: 'open' | 'closed',
		 *            teeth: 6, gap: index of a missing tooth, toothColors, lip, z: centre depth (default 0.17),
		 *            size: [3.47, 3.4, 2.6], ears: true, neck: true }
		 * @returns { center, size, front, top } (front = z of the face plane, top = y of the scalp, relative to the joint)
		 */
		head(part, o) {
			o = o || {};
			const sk = o.skin || ramp('#708b53');
			const front = o.front || toHex(toRGB(sk[0]).map(v => Math.min(255, Math.round(v * 1.12))));
			const S = o.size || [3.47, 3.4, 2.6], C = [0, 2.0, o.z === undefined ? 0.17 : o.z], f = C[2] - S[2] / 2;
			const ex = o.expression || 'angry';
			const B = (p, s, c, q) => this.box(part, p, s, c, Object.assign({ jitter: 0 }, q || {}));
			if (o.neck !== false) B([0, 0.15, C[2]], [1.38, 1.12, 1.36], sk[3]);
			B(C, S, sk[2]);
			B([0, C[1] + 1.1, f + 0.12], [S[0] * 0.82, 1.0, 0.49], front);
			for (const s of [1, -1]) {
				const brow = ex === 'angry' ? s * 13 : ex === 'grin' ? -s * 5 : 0;
				B([s * 0.8, C[1] + 0.75, f - 0.17], [1.44, 0.3, 0.52], sk[3], { rot: [0, 0, brow] });
				B([s * 0.75, C[1] + 0.36, f - 0.05], [1.21, 0.6, 0.21], '#2b2a22');
				B([s * 0.74, C[1] + 0.34, f - 0.19], [0.63, 0.27, 0.16], '#3c3d2c');
				if (o.eyeStyle === 'human') {   // white eyeball + dark pupil, looking slightly inwards
					B([s * 0.74, C[1] + 0.33, f - 0.25], [0.62, 0.32, 0.08], '#f1ede4');
					B([s * 0.62, C[1] + 0.32, f - 0.3], [0.22, 0.28, 0.06], o.eyes || '#2a1d14');
				} else B([s * 0.72, C[1] + 0.33, f - 0.28], [0.3, 0.19, 0.06], o.eyes || '#9cff10', { mat: o.glow === false ? 'SmoothPlastic' : 'Neon', name: 'EyeGlow' });
				B([s * 1.16, C[1] - 0.17, f - 0.11], [0.86, 0.39, 0.45], front, { rot: [0, 0, -s * 20] });
				B([s * 1.24, C[1] - 0.72, f - 0.03], [0.7, 0.77, 0.41], sk[1]);
				if (o.ears !== false) B([s * (S[0] / 2 + 0.02), C[1] + 0.18, C[2] - 0.2], [0.6, 0.93, 0.69], sk[1]);
			}
			B([0, C[1] + 0.07, f - 0.26], [0.45, 0.7, 0.61], front);
			B([0, C[1] - 0.26, f - 0.47], [0.61, 0.32, 0.4], sk[0]);
			const open = (o.mouth || (ex === 'neutral' ? 'closed' : 'open')) === 'open';
			const tc = o.toothColors || ['#e8dcc4', '#d3c3a6'];
			if (open) {
				B([0, C[1] - 0.95, f - 0.04], [1.9, 0.72, 0.14], '#1b1310');
				const nt = o.teeth === undefined ? 6 : o.teeth;
				for (let i = 0; i < nt; i++) if (i !== o.gap) B([-0.72 + i * 1.45 / Math.max(1, nt - 1), C[1] - 0.72, f - 0.14], [0.22, 0.3 - (i % 2) * 0.06, 0.2], tc[i % tc.length]);
				B([0, C[1] - 1.38, f - 0.08], [1.2, 0.22, 0.2], o.lip || '#4a2a24');
			} else {
				B([0, C[1] - 0.63, f - 0.1], [1.18, 0.17, 0.19], sk[2]);
				B([0, C[1] - 0.73, f - 0.04], [1.26, 0.18, 0.19], '#1b1919', { rot: [0, 0, ex === 'grin' ? 5 : 0] });
			}
			return { center: C, size: S, front: f, top: C[1] + S[1] / 2 };
		}

		/**
		 * Hair like the reference: parallel bars lying flat on the scalp from the hairline to the back, short fringe bits at the
		 * front and stepped sideburns. Pass the object returned by head().
		 * @param o { style: 'combed' (default) | 'buzz' (short flat cap) | 'spiky' (bars standing up), bars: 11, sideburns: true }
		 */
		hairCombed(part, h, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const [W, , D] = h.size, top = h.top, cz = h.center[2], n = o.bars || 11, w = W * 0.98 / n;
			this.box(part, [0, top + 0.05, cz + 0.08], [W * 0.98, 0.44, D * 0.94], cols[Math.min(1, cols.length - 1)], { jitter: 0 });
			if (o.style !== 'buzz') for (let i = 0; i < n; i++) {
				const x = -W * 0.49 + (i + 0.5) * w, arch = 0.18 * (1 - Math.abs(x) / (W / 2));
				if (o.style === 'spiky') {
					this.box(part, [x, top + 0.55 + arch, cz + this.rand(-0.3, 0.6)], [w * 0.9, this.rand(0.6, 1.0), 0.5], this.pick(cols), { jitter: 0, rot: [this.rand(-25, 5), 0, -x * 8] });
					continue;
				}
				this.box(part, [x, top + 0.34 + arch, cz + 0.25], [w * 0.98, 0.27, D * 0.88], this.pick(cols), { jitter: 0, rot: [0, 0, -x * 4] });
				this.box(part, [x, top + 0.28 + arch, h.front + 0.05], [w * 1.08, 0.17, 0.3], this.pick(cols), { jitter: 0, rot: [0, 0, -x * 4] });
			}
			if (o.sideburns !== false) for (const s of [1, -1]) for (let i = 0; i < 5; i++)
				this.box(part, [s * (W / 2 - 0.03 - i * 0.04), top - 0.3 - i * 0.22, cz + 0.05], [0.32, 0.45, D * 0.66], this.pick(cols), { jitter: 0, rot: [0, 0, s * 15] });
		}

		/**
		 * A ring of blocks: turned-up collars, fur collars, scarves, neck rings, crowns, wreaths, spike belts.
		 * @param center ring centre (relative to the joint), radius [rx, rz] or one number
		 * @param o      { arc: 0.9 (share of the circle, centred on the back +Z), size: [0.8, 0.64, 0.74], jitter: 14 }
		 */
		collar(part, center, radius, count, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const [rx, rz] = Array.isArray(radius) ? radius : [radius, radius];
			const arc = (o.arc === undefined ? 0.9 : o.arc) * Math.PI * 2, s = o.size || [0.8, 0.64, 0.74];
			for (let i = 0; i < count; i++) {
				const a = Math.PI / 2 - arc / 2 + arc * (count > 1 ? i / (count - 1) : 0.5);
				this.box(part, [center[0] + Math.cos(a) * rx, center[1], center[2] + Math.sin(a) * rz], s, cols[i % cols.length],
					{ jitter: o.jitter === undefined ? 14 : o.jitter, rot: [0, 90 - a / D2R, 0] });
			}
		}

		/** Two-tone stripe band on a face: reflective tape, uniform trim, sport stripes. o: { face: '-Z' | '+X' | '-X', height: 0.42 } */
		band(part, center, width, colors, o) {
			o = o || {};
			const face = o.face || '-Z', h = o.height || 0.42, cols = Array.isArray(colors) ? colors : [colors];
			const size = hh => face === '-Z' ? [width, hh, 0.05] : [0.05, hh, width];
			const out = d => face === '-Z' ? [0, 0, -d] : face === '+X' ? [d, 0, 0] : [-d, 0, 0];
			this.box(part, center, size(h), cols[0], { jitter: 0 });
			if (cols[1]) { const d = out(0.03); this.box(part, [center[0] + d[0], center[1], center[2] + d[2]], size(h * 0.4), cols[1], { jitter: 0 }); }
		}

		/**
		 * Ready-made poses, call after everything is built (they turn limbs about their joints):
		 * 'zombie' (left arm reaches, right low, hunched, head tilted), 'reach' (both arms forward), 'hunch', 'stand'.
		 */
		posePreset(name) {
			const P = {
				zombie: [['UpperL', [62, 0, -8]], ['ForeL', [18, 0, 0]], ['HandL', [-25, 0, 0]], ['UpperR', [12, 0, 6]], ['ForeR', [28, 0, 0]], ['Head', [8, 0, -6]], ['Torso', [9, 0, 0]]],
				reach: [['UpperR', [70, 0, 6]], ['UpperL', [64, 0, -6]], ['ForeR', [12, 0, 0]], ['ForeL', [16, 0, 0]], ['HandR', [-25, 0, 0]], ['HandL', [-25, 0, 0]], ['Head', [6, 0, 5]], ['Torso', [8, 0, 0]]],
				hunch: [['UpperR', [10, 0, 5]], ['UpperL', [14, 0, -5]], ['ForeR', [20, 0, 0]], ['ForeL', [24, 0, 0]], ['Head', [10, 0, 0]], ['Torso', [12, 0, 0]]],
				stand: [['UpperR', [4, 0, 5]], ['UpperL', [4, 0, -5]], ['ForeR', [10, 0, 0]], ['ForeL', [10, 0, 0]]],
			}[name];
			if (!P) throw new Error('Unknown pose preset ' + name + ' (zombie, reach, hunch, stand)');
			for (const [p, r] of P) if (this.parts[p]) this.pose(p, r);
			return this;
		}

		/**
		 * Strands growing from a base area in one direction: beards, hair, manes, fur tufts, feathers, grass, spikes, flames.
		 * Each strand is one block turned about a single axis, fanned out across the base, so the result reads as combed
		 * locks instead of a random heap (which is what blob() would give).
		 * @param base   centre of the base area (relative to the joint)
		 * @param area   [width along X, depth along Z] of the base area
		 * @param dir    growth direction, e.g. [0,-1,-0.3] beard hanging down and a bit forward, [0,1,0.4] hair up and back
		 * @param len    [min, max] strand length
		 * @param o      { thick: [0.18, 0.32], fan: 18 (deg, strands at the sides lean outwards), layers: 1 (back rows shorter
		 *                 and darker give depth), jitter: 6 }
		 */
		strands(part, base, area, count, dir, len, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const [tmin, tmax] = o.thick || [0.18, 0.32];
			const fan = o.fan === undefined ? 18 : o.fan, layers = o.layers || 1;
			const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
			const D = norm(dir);
			// the base spreads along X; strands at the sides lean outwards along X (perpendicular to the growth direction)
			const sideV = norm([1 - D[0] * D[0], -D[0] * D[1], -D[0] * D[2]]);
			for (let i = 0; i < count; i++) {
				const layer = i % layers;                          // 0 = front row
				const u = count > 1 ? ((i + this.rand(-0.35, 0.35)) / (count - 1)) * 2 - 1 : 0; // -1..1 across the width
				const w = this.rand(-0.5, 0.5);
				const shrink = 1 - layer * 0.18;
				const L = this.rand(len[0], len[1]) * shrink * (1 - 0.25 * Math.abs(u));   // shorter at the sides
				const k = Math.tan(fan * u * D2R);
				const Dd = norm([D[0] + sideV[0] * k, D[1] + sideV[1] * k, D[2] + sideV[2] * k]);
				const R = mulM(fromTo([0, 1, 0], Dd), this.tilt(null, o.jitter === undefined ? 6 : o.jitter, 1));   // spin about its own length only
				const t = this.rand(tmin, tmax);
				const b = [base[0] + u * area[0] / 2, base[1], base[2] + w * area[1] + layer * 0.14];   // back rows sit further back (+Z)
				const c = cols[Math.min(cols.length - 1, layer + (this.rnd() < 0.5 ? 0 : 1))] || cols[0];
				const v = this.box(part, [b[0] + Dd[0] * L / 2, b[1] + Dd[1] * L / 2, b[2] + Dd[2] * L / 2], [t * this.rand(0.8, 1.3), L, t], c,
					{ jitter: 0, mat: o.mat, name: o.name });
				v.R = R;
			}
		}

		/** Scatter blocks inside an ellipsoid: rubble, moss specks, slime puddles, foam, sparks. For hair/beards use strands(). */
		blob(part, center, radii, count, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const [smin, smax] = o.size || [0.15, 0.45];
			for (let i = 0; i < count; i++) {
				let x, y, z;
				do { x = this.rand(-1, 1); y = this.rand(-1, 1); z = this.rand(-1, 1); } while (x * x + y * y + z * z > 1);
				if (o.top) y = Math.abs(y); // only the upper half (hair, caps)
				const s0 = this.rand(smin, smax);
				const s = [s0 * this.rand(0.7, 1.3), s0 * this.rand(0.7, 1.3), s0 * this.rand(0.7, 1.3)];
				this.box(part, [center[0] + x * radii[0], center[1] + y * radii[1], center[2] + z * radii[2]], s, this.pick(cols),
					{ jitter: o.jitter === undefined ? 18 : o.jitter, mat: o.mat, t: o.t, abs: o.abs, name: o.name });
			}
		}

		/** A run of blocks from a to b (relative to the part's joint): straps, belts, stitches, cracks, tubes, ropes. */
		line(part, a, b, thickness, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			const len = Math.hypot(d[0], d[1], d[2]);
			const n = o.count || Math.max(1, Math.round(len / (thickness * 2.2)));
			for (let i = 0; i < n; i++) {
				const t = (i + 0.5) / n;
				const seg = len / n * (o.gap === undefined ? 1.05 : 1 - o.gap);
				// orient the segment's X axis along the line
				const yaw = Math.atan2(-d[2], d[0]) / D2R, pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) / D2R;
				const v = this.box(part, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], [seg, thickness, thickness], this.pick(cols),
					{ jitter: o.jitter === undefined ? 6 : o.jitter, mat: o.mat, name: o.name });
				v.R = mulM(euler(0, yaw, pitch), v.R);
			}
		}

		/**
		 * Hanging strips along an edge from a to b: torn hems, rags, fur fringes, moss, icicles, slime drips.
		 * @param len   [min, max] strip length downwards
		 */
		fringe(part, a, b, count, len, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const width = o.width || Math.hypot(b[0] - a[0], b[2] - a[2]) / count * 0.9;
			for (let i = 0; i < count; i++) {
				const t = (i + 0.5) / count, L = this.rand(len[0], len[1]);
				const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - L / 2, a[2] + (b[2] - a[2]) * t];
				const yaw = Math.atan2(-(b[2] - a[2]), b[0] - a[0]) / D2R;
				const v = this.box(part, p, [width * this.rand(0.7, 1.1), L, o.thick || 0.12], this.pick(cols), { jitter: o.jitter === undefined ? 10 : o.jitter, mat: o.mat, name: o.name, tiltAxis: 2 });
				v.R = mulM(euler(0, yaw, 0), v.R);
			}
		}

		// ---------- glow and colour tools (the reference's strongest effects) ----------
		/**
		 * A glowing crack / seam / ember line from a to b: thin zig-zag Neon segments sitting in a dark groove.
		 * Use on limbs, boots, armour, rocks, weapons. @param colors neon colours (use neonRamp)
		 * Place a and b ON the surface. Give `normal` (the direction the surface faces, e.g. [1,0,0] on the right side,
		 * [0,0,-1] on the front) to get a dark groove around the glow; the glow then sits slightly proud of the groove.
		 * @param o { width: 0.09, normal: [x,y,z], groove: '#1c1a1f', segments, wobble: 0.12, name: 'FissureGlow' }
		 */
		crack(part, a, b, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			const w = o.width || 0.09, n = o.segments || Math.max(3, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.3));
			const N = o.normal ? (l => o.normal.map(x => x / l))(Math.hypot(...o.normal)) : null;
			const lift = N ? N.map(x => x * w * 0.9) : [0, 0, 0];
			let prev = a.slice();
			for (let i = 1; i <= n; i++) {
				const t = i / n, wob = i === n ? 0 : (o.wobble === undefined ? 0.12 : o.wobble);
				// wobble only within the surface (never along the normal, so the glow does not sink in)
				const wv = [this.rand(-wob, wob), this.rand(-wob, wob), this.rand(-wob, wob)];
				if (N) { const d = wv[0] * N[0] + wv[1] * N[1] + wv[2] * N[2]; for (let k = 0; k < 3; k++) wv[k] -= d * N[k]; } else wv[2] = 0;
				const next = [a[0] + (b[0] - a[0]) * t + wv[0], a[1] + (b[1] - a[1]) * t + wv[1], a[2] + (b[2] - a[2]) * t + wv[2]];
				if (N && o.groove !== null) this.line(part, prev, next, w * 2.3, o.groove || '#1c1a1f', { count: 1, jitter: 0 });
				this.line(part, prev.map((x, k) => x + lift[k]), next.map((x, k) => x + lift[k]), w, cols, { count: 1, jitter: 0, mat: 'Neon', name: o.name || 'FissureGlow' });
				prev = next;
			}
		}
		/** Glowing drips hanging from an edge (slime, lava, ectoplasm, melted candle). A fringe in Neon with a drop at the end. */
		drips(part, a, b, count, len, colors, o) {
			o = o || {};
			const cols = Array.isArray(colors) ? colors : [colors];
			for (let i = 0; i < count; i++) {
				const t = (i + this.rand(0.1, 0.9)) / count, L = this.rand(len[0], len[1]), w = o.width || this.rand(0.1, 0.2);
				const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
				this.box(part, [x, y - L / 2, z], [w, L, w], this.pick(cols), { jitter: 4, mat: 'Neon', name: o.name || 'SlimeGlow' });
				this.box(part, [x, y - L - w * 0.4, z], [w * 1.5, w * 1.3, w * 1.5], this.pick(cols), { jitter: 12, mat: 'Neon', name: o.name || 'SlimeGlow' });
			}
		}
		/**
		 * A light source: a Neon core inside a dark or glass cage (lantern, reactor, potion, gem, tank, muzzle, robot eye).
		 * @param o { axis: 'y' (caps top/bottom, default) | 'x' | 'z' (caps on the ends, e.g. a muzzle or chest reactor facing -Z),
		 *            open: true (leave the cap off the minus side of the axis, so a -Z muzzle shows its glow),
		 *            glass: true (a glass shell dims and tints the core a little; false for a pure glow), glassColor, frame, bars }
		 */
		glowCore(part, pos, size, color, o) {
			o = o || {};
			const frame = o.frame || '#2a2730';
			const ax = { x: 0, y: 1, z: 2 }[o.axis || 'y'];
			const [u, w] = [0, 1, 2].filter(k => k !== ax);
			this.box(part, pos, size.map(s => s * 0.72), color, { mat: 'Neon', jitter: 0, name: o.name || 'CoreGlow' });
			if (o.glass !== false) this.box(part, pos, size.map(s => s * 0.9), o.glassColor || '#bfe8ff', { mat: 'Glass', t: 0.55, jitter: 0 });
			for (const sg of [-1, 1]) {
				const p = pos.slice(); p[ax] += sg * size[ax] / 2;
				const s = size.map(x => x * 1.08); s[ax] = size[ax] * 0.14;
				if (!(o.open && sg === -1)) this.box(part, p, s, frame, { jitter: 0 });   // open: no cap on the minus side (a -Z muzzle)
			}
			if (o.bars !== false) for (const su of [-1, 1]) for (const sw of [-1, 1]) {
				const p = pos.slice(); p[u] += su * size[u] * 0.47; p[w] += sw * size[w] * 0.47;
				const s = [0.1, 0.1, 0.1]; s[ax] = size[ax];
				this.box(part, p, s, frame, { jitter: 0 });
			}
		}

		/**
		 * Diagonal warning stripes (hazard tape, racing stripes, candy cane) on a flat face: a plate in colors[0] with
		 * slanted bars in colors[1] on top. Bars that would stick out past the ends are left off. ~3 voxels per stripe.
		 * Put `center` 0.12-0.15 in front of a chunk's core face so the bumps do not cover it.
		 * @param size  [width, height] of the band on that face
		 * @param o     { face: '-Z'|'+Z'|'-X'|'+X'|'+Y', period: 0.5 (distance between bars), angle: 35 (degrees, negative leans the other way), depth: 0.06 }
		 */
		stripes(part, center, size, colors, o) {
			o = o || {};
			const [W, H] = size, d = o.depth || 0.06, period = o.period || 0.5, ang = o.angle === undefined ? 35 : o.angle;
			const face = o.face || '-Z', bw = period / 2, t = Math.tan(ang * D2R), c = Math.cos(ang * D2R);
			const Wu = W / 2 - bw / (2 * c), Hv = H / 2 - Math.abs(bw * Math.sin(ang * D2R)) / 2;   // keep bar corners inside
			// u runs along the band (to the viewer's right), v up; returns position, size and in-plane rotation for this face
			const place = (u, v, lu, lv, thick, a) => {
				if (face === '-Z') return { p: [center[0] - u, center[1] + v, center[2]], s: [lu, lv, thick], rot: [0, 0, a] };
				if (face === '+Z') return { p: [center[0] + u, center[1] + v, center[2]], s: [lu, lv, thick], rot: [0, 0, -a] };
				if (face === '-X') return { p: [center[0], center[1] + v, center[2] + u], s: [thick, lv, lu], rot: [a, 0, 0] };
				if (face === '+X') return { p: [center[0], center[1] + v, center[2] - u], s: [thick, lv, lu], rot: [-a, 0, 0] };
				return { p: [center[0] + u, center[1], center[2] - v], s: [lu, thick, lv], rot: [0, -a, 0] };
			};
			const normal = face === '+Y' ? [0, 1, 0] : face.endsWith('X') ? [face[0] === '+' ? 1 : -1, 0, 0] : [0, 0, face[0] === '+' ? 1 : -1];
			const base = place(0, 0, W, H, d, 0);
			this.box(part, base.p, base.s, colors[0], { jitter: 0, rot: base.rot });
			// each bar is the line u = u0 + v * tan(angle), clipped to the band; works for wide and tall bands
			const span = W / 2 + (H / 2) * Math.abs(t);
			for (let u0 = -span + ((2 * span) % period) / 2; u0 <= span + 1e-6; u0 += period) {
				let v0 = -Hv, v1 = Hv;
				if (Math.abs(t) > 1e-6) { const a = (-Wu - u0) / t, b = (Wu - u0) / t; v0 = Math.max(v0, Math.min(a, b)); v1 = Math.min(v1, Math.max(a, b)); }
				else if (Math.abs(u0) > Wu) continue;
				if (v1 - v0 < bw * 0.8) continue;
				const vc = (v0 + v1) / 2, L = (v1 - v0) / c;
				const q = place(u0 + vc * t, vc, bw, L, d, ang);
				q.p = q.p.map((x, k) => x + normal[k] * d * 0.6);
				this.box(part, q.p, q.s, colors[1] || colors[0], { jitter: 0, rot: q.rot });
			}
			return this;
		}
		/**
		 * Pixel-art emblem made of tiny blocks on a face: hazard signs, pumpkin faces, runes, logos, number plates.
		 * @param rows   strings, top row first; each character picks a colour from `palette` ('.' or ' ' = empty)
		 * @param o      { pixel: 0.12, face: '-Z' | '+Z' | '-X' | '+X' | '+Y', depth: 0.05, mat: per-character override map e.g. {g:'Neon'} }
		 */
		emblem(part, center, rows, palette, o) {
			o = o || {};
			const px = o.pixel || 0.12, d = o.depth || 0.05, face = o.face || '-Z';
			const h = rows.length, w = Math.max(...rows.map(r => r.length));
			rows.forEach((row, j) => [...row].forEach((ch, i) => {
				if (ch === '.' || ch === ' ' || !(ch in palette)) return;
				const u = (i - (w - 1) / 2) * px, v = ((h - 1) / 2 - j) * px;
				let p;
				if (face === '-Z') p = [center[0] - u, center[1] + v, center[2]];
				else if (face === '+Z') p = [center[0] + u, center[1] + v, center[2]];
				else if (face === '-X') p = [center[0], center[1] + v, center[2] + u];
				else if (face === '+X') p = [center[0], center[1] + v, center[2] - u];
				else p = [center[0] + u, center[1], center[2] - v];
				const size = face.endsWith('X') ? [d, px, px] : face === '+Y' ? [px, d, px] : [px, px, d];
				const mat = (o.mat && o.mat[ch]) || 'SmoothPlastic';
				this.box(part, p, size, palette[ch], { jitter: 0, mat, name: mat === 'Neon' ? (o.name || 'EmblemGlow') : 'Voxel' });
			}));
		}

		/** All body parts hanging below `name` (including itself). */
		subtree(name) {
			const out = [name];
			for (const k in this.parts) if (this.parts[k].parent === name) out.push(...this.subtree(k));
			return out;
		}
		/**
		 * Pose the figure: turn a body part and everything below it about its joint (degrees, like CFrame.Angles).
		 * +rx lifts an arm forward (towards -Z), +rz on UpperR swings it out to the side. Call AFTER mirror(),
		 * the exported model keeps this pose as its rest pose. Use poseBoth() for symmetric poses.
		 */
		pose(name, rot) {
			const M = euler(rot[0], rot[1] || 0, rot[2] || 0), J = this.joint(name).slice(), set = new Set(this.subtree(name));
			const turn = p => { const d = mulV(M, [p[0] - J[0], p[1] - J[1], p[2] - J[2]]); return [J[0] + d[0], J[1] + d[1], J[2] + d[2]]; };
			for (const v of this.voxels) if (set.has(v.part)) { v.p = turn(v.p); v.R = mulM(M, v.R); }
			for (const k of set) if (k !== name) this.parts[k].joint = turn(this.parts[k].joint);
			this.posed = true;
			return this;
		}
		/** Same pose on both sides: pose(base+'R', rot) and the mirrored angles on base+'L'. */
		poseBoth(base, rot) {
			this.pose(base + 'R', rot);
			return this.pose(base + 'L', [rot[0], -(rot[1] || 0), -(rot[2] || 0)]);
		}

		/** Copy every voxel of parts ending in `from` ('R' or 'L') to the other side, mirrored across x = 0. */
		mirror(from) {
			from = from || 'R';
			const to = from === 'R' ? 'L' : 'R';
			const src = this.voxels.filter(v => v.part.endsWith(from) && !v.mirrored);
			for (const v of src) {
				const target = v.part.slice(0, -1) + to;
				if (!this.parts[target]) {
					const sp = this.parts[v.part];
					const par = sp.parent && sp.parent.endsWith(from) ? sp.parent.slice(0, -1) + to : sp.parent;
					this.parts[target] = { joint: [-sp.joint[0], sp.joint[1], sp.joint[2]], parent: par };
				}
				const R = v.R;
				v.mirrored = true;
				this.voxels.push({ mirrored: true,
					part: target, p: [-v.p[0], v.p[1], v.p[2]], s: v.s.slice(), c: v.c.slice(), mat: v.mat, t: v.t, shape: v.shape, name: v.name,
					R: [R[0], -R[1], -R[2], -R[3], R[4], R[5], -R[6], R[7], R[8]],
				});
			}
			return this;
		}

		/** Remove every voxel of a body part (e.g. clear('ForeR') before building a cannon arm in its place). */
		clear(part) {
			this.voxels = this.voxels.filter(v => v.part !== part);
			return this;
		}

		/** Body parts that hold voxels, plus every parent on the way up (so the joint chain stays complete). */
		usedParts() {
			const keep = new Set();
			for (const v of this.voxels) {
				let p = v.part;
				while (p && this.parts[p] && !keep.has(p)) { keep.add(p); p = this.parts[p].parent; }
			}
			return Object.keys(this.parts).filter(k => keep.has(k));
		}
		/** Drop body parts nothing uses, so Studio gets no empty models. */
		prune() {
			const keep = new Set(this.usedParts());
			for (const k of Object.keys(this.parts)) if (!keep.has(k)) delete this.parts[k];
			return this;
		}

		stats() {
			const per = {}, colors = new Set();
			let neon = 0, minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
			for (const v of this.voxels) {
				per[v.part] = (per[v.part] || 0) + 1; colors.add(v.c.join());
				if (v.mat === 'Neon') neon++;
				const R = v.R, s = v.s;
				const hx = (Math.abs(R[0]) * s[0] + Math.abs(R[1]) * s[1] + Math.abs(R[2]) * s[2]) / 2;
				const hy = (Math.abs(R[3]) * s[0] + Math.abs(R[4]) * s[1] + Math.abs(R[5]) * s[2]) / 2;
				minY = Math.min(minY, v.p[1] - hy); maxY = Math.max(maxY, v.p[1] + hy);
				minX = Math.min(minX, v.p[0] - hx); maxX = Math.max(maxX, v.p[0] + hx);
			}
			return { voxels: this.voxels.length, perPart: per, colors: colors.size, neon, height: +(maxY - minY).toFixed(2), bottom: +minY.toFixed(2), width: +(maxX - minX).toFixed(2) };
		}

		toJSON() {
			return { name: this.name, opts: this.opts, parts: this.parts, voxels: this.voxels.map(v => Object.assign({}, v, { R: v.R.map(f4), p: v.p.map(f4), s: v.s.map(f4) })) };
		}
		static fromJSON(o) {
			const f = new Figure(o.name, Object.assign({}, o.opts, { skeleton: 'none' }));
			f.parts = JSON.parse(JSON.stringify(o.parts));
			f.voxels = o.voxels.map(v => Object.assign({}, v));
			return f;
		}

		// ---------- Roblox .rbxmx ----------
		/** @param o { scale: 1, anchored: true } */
		toRbxmx(o) {
			o = Object.assign({ scale: 1, anchored: true }, o || {});
			const S = o.scale;
			let ref = 0;
			const nextRef = () => 'RBX' + (++ref).toString(16).toUpperCase().padStart(8, '0');
			const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			const cf = (tag, name, p, R) => `<${tag} name="${name}"><X>${f4(p[0])}</X><Y>${f4(p[1])}</Y><Z>${f4(p[2])}</Z>` +
				`<R00>${f4(R[0])}</R00><R01>${f4(R[1])}</R01><R02>${f4(R[2])}</R02><R10>${f4(R[3])}</R10><R11>${f4(R[4])}</R11><R12>${f4(R[5])}</R12>` +
				`<R20>${f4(R[6])}</R20><R21>${f4(R[7])}</R21><R22>${f4(R[8])}</R22></${tag}>`;
			const pivot = (p) => `<OptionalCoordinateFrame name="WorldPivotData">${cf('CFrame', '', p, [1, 0, 0, 0, 1, 0, 0, 0, 1]).replace(' name=""', '')}</OptionalCoordinateFrame>`;
			const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
			const out = [];
			out.push('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">');
			out.push(`<Item class="Model" referent="${nextRef()}"><Properties><string name="Name">${esc(this.name)}</string>${pivot([0, 0, 0])}` +
				`<BinaryString name="AttributesSerialize">${attributes({ VoxelKit: 'v1', Scale: S })}</BinaryString></Properties>`);
			for (const pn of this.usedParts()) {
				const part = this.parts[pn];
				const vox = this.voxels.filter(v => v.part === pn);
				const J = part.joint.map(x => x * S);
				out.push(`<Item class="Model" referent="${nextRef()}"><Properties><string name="Name">${esc(pn)}</string>${pivot(J)}` +
					`<BinaryString name="AttributesSerialize">${attributes({ Joint: J, ParentJoint: part.parent || '' })}</BinaryString></Properties>`);
				for (const v of vox) {
					const col = (0xff000000 | (v.c[0] << 16) | (v.c[1] << 8) | v.c[2]) >>> 0;
					out.push(`<Item class="Part" referent="${nextRef()}"><Properties>` +
						`<string name="Name">${esc(v.name)}</string>` +
						`<bool name="Anchored">${o.anchored}</bool><bool name="CanCollide">false</bool><bool name="CanQuery">false</bool><bool name="CanTouch">false</bool>` +
						`<bool name="CastShadow">true</bool><bool name="Locked">false</bool>` +
						cf('CoordinateFrame', 'CFrame', v.p.map(x => x * S), v.R) +
						`<Color3uint8 name="Color3uint8">${col}</Color3uint8>` +
						`<token name="Material">${MATERIALS[v.mat]}</token>` +
						`<float name="Transparency">${f4(v.t)}</float>` +
						`<token name="shape">${SHAPES[v.shape] || 1}</token>` +
						`<token name="TopSurface">0</token><token name="BottomSurface">0</token>` +
						`<Vector3 name="size"><X>${f4(v.s[0] * S)}</X><Y>${f4(v.s[1] * S)}</Y><Z>${f4(v.s[2] * S)}</Z></Vector3>` +
						`</Properties></Item>`);
				}
				out.push('</Item>');
			}
			out.push('</Item></roblox>');
			return out.join('\n');
		}

		// ---------- glTF binary (.glb) ----------
		/** One node per body part (named like the part, origin at its joint), one primitive per colour/material. */
		toGLB(o) {
			o = Object.assign({ scale: 1, segments: 12 }, o || {});
			const S = o.scale;
			const json = { asset: { version: '2.0', generator: 'VoxelKit v1' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: this.name, children: [] }], meshes: [], materials: [], accessors: [], bufferViews: [] };
			const chunks = []; let offset = 0;
			const addView = (arr, target) => {
				const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
				json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
				chunks.push(bytes); offset += bytes.length;
				const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
				return json.bufferViews.length - 1;
			};
			const matIndex = {};
			const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
			const material = v => {
				const key = v.c.join() + '|' + v.mat + '|' + v.t;
				if (key in matIndex) return matIndex[key];
				const col = v.c.map(lin);
				const m = { name: toHex(v.c) + '_' + v.mat, pbrMetallicRoughness: { baseColorFactor: [col[0], col[1], col[2], 1 - v.t], metallicFactor: v.mat === 'Metal' ? 0.6 : 0, roughnessFactor: v.mat === 'Glass' ? 0.1 : 0.85 } };
				if (v.mat === 'Neon') m.emissiveFactor = col.map(x => Math.min(1, x * 1.5));
				if (v.t > 0) m.alphaMode = 'BLEND';
				json.materials.push(m);
				return (matIndex[key] = json.materials.length - 1);
			};
			for (const pn of Object.keys(this.parts)) {
				const vox = this.voxels.filter(v => v.part === pn && v.t < 1);
				if (!vox.length) continue;
				const J = this.parts[pn].joint;
				const groups = new Map();
				for (const v of vox) { const k = material(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
				const prims = [];
				for (const [mi, list] of groups) {
					const P = [], N = [], IDX = [];
					for (const v of list) geometry(v, J, S, o.segments, P, N, IDX);
					const pos = new Float32Array(P), nor = new Float32Array(N), idx = new Uint32Array(IDX);
					const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
					for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
					json.accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
					const aPos = json.accessors.length - 1;
					json.accessors.push({ bufferView: addView(nor, 34962), componentType: 5126, count: nor.length / 3, type: 'VEC3' });
					const aNor = json.accessors.length - 1;
					json.accessors.push({ bufferView: addView(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
					prims.push({ attributes: { POSITION: aPos, NORMAL: aNor }, indices: json.accessors.length - 1, material: mi });
				}
				json.meshes.push({ name: pn, primitives: prims });
				json.nodes.push({ name: pn, translation: J.map(x => x * S), mesh: json.meshes.length - 1 });
				json.nodes[0].children.push(json.nodes.length - 1);
			}
			json.buffers = [{ byteLength: offset }];
			const enc = new TextEncoder();
			let jb = enc.encode(JSON.stringify(json));
			const jpad = (4 - (jb.length % 4)) % 4;
			if (jpad) { const t = new Uint8Array(jb.length + jpad); t.set(jb); t.fill(0x20, jb.length); jb = t; }
			const total = 12 + 8 + jb.length + 8 + offset;
			const out = new Uint8Array(total); const dv = new DataView(out.buffer);
			dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
			dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
			let p = 20 + jb.length;
			dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
			for (const c of chunks) { out.set(c, p); p += c.length; }
			return out;
		}
	}

	// faces of a box: normal axis, sign, and the two tangent axes (u x v = normal), so triangles wind counter-clockwise outside
	const FACES = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
	function geometry(v, J, S, seg, P, N, IDX) {
		const h = v.s.map(x => x / 2);
		const c = [v.p[0] - J[0], v.p[1] - J[1], v.p[2] - J[2]];
		const put = (local, nrm) => {
			const w = mulV(v.R, local), n = mulV(v.R, nrm);
			P.push((c[0] + w[0]) * S, (c[1] + w[1]) * S, (c[2] + w[2]) * S); N.push(n[0], n[1], n[2]);
			return P.length / 3 - 1;
		};
		if (v.shape === 'Cylinder') {
			const r = Math.min(v.s[1], v.s[2]) / 2, hx = h[0];
			const ring = i => { const a = (i / seg) * 2 * Math.PI; return [Math.cos(a) * r, Math.sin(a) * r]; };
			for (let i = 0; i < seg; i++) {
				const [y0, z0] = ring(i), [y1, z1] = ring(i + 1), am = ((i + 0.5) / seg) * 2 * Math.PI, n = [0, Math.cos(am), Math.sin(am)];
				const a = put([-hx, y0, z0], n), b = put([-hx, y1, z1], n), d = put([hx, y1, z1], n), e = put([hx, y0, z0], n);
				IDX.push(a, b, d, a, d, e);
				const cp = put([hx, 0, 0], [1, 0, 0]), p0 = put([hx, y0, z0], [1, 0, 0]), p1 = put([hx, y1, z1], [1, 0, 0]);
				IDX.push(cp, p0, p1);
				const cm = put([-hx, 0, 0], [-1, 0, 0]), m0 = put([-hx, y0, z0], [-1, 0, 0]), m1 = put([-hx, y1, z1], [-1, 0, 0]);
				IDX.push(cm, m1, m0);
			}
			return;
		}
		for (const [ax, sg, ua, va] of FACES) {
			const n = [0, 0, 0]; n[ax] = sg;
			const corner = (su, sv) => { const l = [0, 0, 0]; l[ax] = sg * h[ax]; l[ua] = su * h[ua]; l[va] = sv * h[va]; return l; };
			const a = put(corner(-1, -1), n), b = put(corner(1, -1), n), d = put(corner(1, 1), n), e = put(corner(-1, 1), n);
			IDX.push(a, b, d, a, d, e);
		}
	}

	// Roblox AttributesSerialize (binary, base64): strings, numbers (double) and Vector3.
	function attributes(obj) {
		const parts = []; const enc = new TextEncoder();
		const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
		const str = s => { const e = enc.encode(s); return [u32(e.length), e]; };
		const keys = Object.keys(obj);
		parts.push(u32(keys.length));
		for (const k of keys) {
			const v = obj[k];
			parts.push(...str(k));
			if (typeof v === 'string') { parts.push(new Uint8Array([0x02]), ...str(v)); }
			else if (typeof v === 'number') { const b = new Uint8Array(9); b[0] = 0x06; new DataView(b.buffer).setFloat64(1, v, true); parts.push(b); }
			else if (Array.isArray(v) && v.length === 3) { const b = new Uint8Array(13); b[0] = 0x11; const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setFloat32(1 + i * 4, x, true)); parts.push(b); }
		}
		const len = parts.reduce((a, p) => a + p.length, 0); const all = new Uint8Array(len); let o = 0;
		for (const p of parts) { all.set(p, o); o += p.length; }
		return b64(all);
	}
	function b64(u8) {
		if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
		let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
		return btoa(s);
	}

	return { Figure, SKELETON, QUADRUPED, PRESETS, MATERIALS, ramp, neonRamp, toRGB, toHex, euler, b64, version: 'v1' };
});
