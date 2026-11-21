/*
 * StudKit: stud / LEGO-style voxel models for Roblox, built in the browser (no Blender). Three model kinds:
 *
 *   Creature  (critters, pets, small animated mobs): boxes owned by bones, animation clips, export .rbxmx (Parts with studs,
 *             Motor6D rig, Clips + StudAnimator modules) and Data/Clips .luau.   Units metres, Z up, front -Y, left +X.
 *   Grid      (bosses, big mobs, machines): a voxel grid sculpted with signed-distance shapes, 1 brick = 2.5 studs.
 *             Design coords x right, y up, z back (front -z). Export .glb (vertex colours + stud texture, optional bones).
 *   Building  (shops, towers, gates, props): big shapes in units with surface patterns + fine-brick details, turned into a Grid.
 *
 * The API mirrors a Blender stud pipeline (box rig, numpy brick grid, building grid) so recipes written for it port 1:1.
 * Works in a browser (<script>) and in Node (require). No dependencies. Rendering lives in studviewer.js.
 */
(function (root, factory) {
	const kit = factory();
	if (typeof module === 'object' && module.exports) module.exports = kit;
	else root.StudKit = kit;
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';
	const VERSION = '1.0.0';
	const TAU = Math.PI * 2, D2R = Math.PI / 180;

	// ---------------------------------------------------------------- small helpers
	function rgb(c) {                                   // '#ff00aa' | 'ff00aa' | [r,g,b] 0..1 -> [r,g,b] 0..1
		if (Array.isArray(c) || c instanceof Float32Array) return [c[0], c[1], c[2]];
		const h = String(c).replace('#', '');
		if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('Bad colour "' + c + '" (use 6 hex digits like "ffd83f")');
		return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
	}
	const hexOf = c => rgb(c).map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');
	const lin = x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
	const f4 = x => +(+x).toFixed(4);
	const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
	const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
	const mulS = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const len = a => Math.hypot(a[0], a[1], a[2]);
	const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
	// 3x3 matrices row-major [m00 m01 m02 m10 ... m22]
	const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
	function mm(A, B) { const r = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return r; }
	const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
	const tr = R => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
	const fromCols = (x, y, z) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
	/** Blender Euler XYZ in degrees (X applied first): R = Rz * Ry * Rx. Same as studlib.py rot=(rx, ry, rz). */
	function euler(rx, ry, rz) {
		const a = rx * D2R, b = ry * D2R, c = rz * D2R;
		const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
		return [cc * cb, -sc * ca + cc * sb * sa, sc * sa + cc * sb * ca,
			sc * cb, cc * ca + sc * sb * sa, -cc * sa + sc * sb * ca,
			-sb, cb * sa, cb * ca];
	}
	function axisAngle(ax, a) {
		const [x, y, z] = norm(ax), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
		return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
	}
	function fromTo(a, b) {                              // rotation turning direction a into b
		a = norm(a); b = norm(b);
		const ax = cross(a, b), s = len(ax), c = dot(a, b);
		if (s < 1e-9) return c > 0 ? I3() : axisAngle(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]), Math.PI);
		return axisAngle(ax, Math.atan2(s, c));
	}
	function quat(R) {                                   // rotation matrix -> [x, y, z, w]
		const t = R[0] + R[4] + R[8]; let x, y, z, w;
		if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = s / 4; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s; }
		else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; w = (R[7] - R[5]) / s; x = s / 4; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s; }
		else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = s / 4; z = (R[5] + R[7]) / s; }
		else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = s / 4; }
		return [x, y, z, w];
	}
	// Blender / design (x, y, z; Z up, front -Y)  ->  Roblox (-x, z, y; Y up, front -Z). A proper rotation (det +1).
	const M = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
	const toR = v => [-v[0], v[2], v[1]];
	const conjM = R => mm(mm(M, R), tr(M));

	// ---------------------------------------------------------------- Roblox XML helpers
	let REF = 0;
	const nextRef = () => 'RBX' + (++REF).toString(16).toUpperCase().padStart(8, '0');
	const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const cfXml = (name, p, R) => `<CoordinateFrame name="${name}"><X>${f4(p[0])}</X><Y>${f4(p[1])}</Y><Z>${f4(p[2])}</Z>` +
		`<R00>${f4(R[0])}</R00><R01>${f4(R[1])}</R01><R02>${f4(R[2])}</R02><R10>${f4(R[3])}</R10><R11>${f4(R[4])}</R11><R12>${f4(R[5])}</R12>` +
		`<R20>${f4(R[6])}</R20><R21>${f4(R[7])}</R21><R22>${f4(R[8])}</R22></CoordinateFrame>`;
	const v3Xml = (name, v) => `<Vector3 name="${name}"><X>${f4(v[0])}</X><Y>${f4(v[1])}</Y><Z>${f4(v[2])}</Z></Vector3>`;
	function b64(u8) {
		if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
		let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
		return btoa(s);
	}
	function attributes(obj) {                           // Roblox AttributesSerialize: string, number, Vector3
		const parts = [], enc = new TextEncoder();
		const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
		const str = s => { const e = enc.encode(s); return [u32(e.length), e]; };
		const keys = Object.keys(obj); parts.push(u32(keys.length));
		for (const k of keys) {
			const v = obj[k]; parts.push(...str(k));
			if (typeof v === 'string') parts.push(new Uint8Array([0x02]), ...str(v));
			else if (typeof v === 'number') { const b = new Uint8Array(9); b[0] = 0x06; new DataView(b.buffer).setFloat64(1, v, true); parts.push(b); }
			else { const b = new Uint8Array(13); b[0] = 0x11; const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setFloat32(1 + i * 4, x, true)); parts.push(b); }
		}
		const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
		for (const p of parts) { all.set(p, o); o += p.length; }
		return b64(all);
	}
	const attrXml = obj => `<BinaryString name="AttributesSerialize">${attributes(obj)}</BinaryString>`;
	const MAT = { Plastic: 256, SmoothPlastic: 272, Neon: 288 };

	// ================================================================ CREATURE (box rig)
	const BOX_FACES = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
	class Creature {
		/**
		 * @param d { NAME, STUDS: studs per metre (5 = critter ~8 studs tall), PALETTE: {key: 'rrggbb'}, GLOW: [keys],
		 *            NOSTUD: [keys] (default eyes EY IR WH SH PU), BONES: [[name, head, tail, parent]],
		 *            HEAD: { scale, pivot, bones, offset } (chibi head: those bones' boxes scale round pivot) }
		 */
		constructor(d) {
			this.NAME = d.NAME || d.name || 'Creature';
			this.STUDS = d.STUDS || 5;
			this.PALETTE = {};
			for (const k in d.PALETTE) this.PALETTE[k] = hexOf(d.PALETTE[k]);
			this.GLOW = new Set(d.GLOW || []);
			this.NOSTUD = new Set([...(d.NOSTUD || ['EY', 'IR', 'WH', 'SH', 'PU']), ...this.GLOW]);
			const H = d.HEAD || {};
			this.HK = H.scale || 1; this.HP = H.pivot || [0, 0, 0]; this.HO = H.offset || [0, 0, 0]; this.HEADISH = new Set(H.bones || []);
			if (!d.BONES || !d.BONES.length) throw new Error('BONES missing: [[name, head, tail, parent], ...], root first');
			this.BONES = d.BONES.map(([n, h, t, p]) => (this.HEADISH.has(n) ? [n, this.xf(h), this.xf(t), p] : [n, h.slice(), t.slice(), p || null]));
			this.BI = {}; this.BONES.forEach((b, i) => { this.BI[b[0]] = i; if (b[3] && !(b[3] in this.BI)) throw new Error('Bone "' + b[0] + '": parent "' + b[3] + '" must come before it'); });
			this.boxes = []; this.CLIPS = {}; this.PREVIEW = {};
			for (const m of ['box', 'span', 'sym', 'sides', 'wedge', 'ramp', 'cyl', 'limb', 'spike', 'stack', 'frame']) this[m] = this[m].bind(this);
		}
		xf(v) { return [0, 1, 2].map(i => this.HP[i] + (v[i] - this.HP[i]) * this.HK + this.HO[i]); }
		_chk(k, bone) {
			if (!(k in this.PALETTE)) throw new Error('Colour key "' + k + '" is not in PALETTE');
			if (!(bone in this.BI)) throw new Error('Bone "' + bone + '" is not in BONES');
		}
		_push(c, s, k, bone, R, shape) {
			this._chk(k, bone);
			if (this.HEADISH.has(bone)) { c = this.xf(c); s = s.map(a => a * this.HK); }
			this.boxes.push({ c: c.slice(), s: s.map(Math.abs), k, bone, R, shape });
		}
		/** Box at centre c with size s (metres). rot = [rx, ry, rz] degrees (Blender XYZ) or pass R (3x3 row-major). */
		box(c, s, k, bone, rot, R) {
			if (rot && !Array.isArray(rot)) { R = rot.R; rot = rot.rot; }
			this._push(c, s, k, bone, R || euler(...(rot || [0, 0, 0])), 'Box');
		}
		/** Box by ranges, (y, x, z) order on purpose: creatures are built in front-to-back slices. */
		span(y0, y1, x0, x1, z0, z1, k, bone) { this.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], k, bone); }
		/** Mirrored pair across x. Use '%' in the bone name for sided bones: sym(..., 'wing.%'). */
		sym(y0, y1, x0, x1, z0, z1, k, bone) { for (const [sx, s] of this.sides()) this.span(y0, y1, x0 * sx, x1 * sx, z0, z1, k, bone.replace('%', s)); }
		/** for (const [sx, s] of sides()) ... -> [1, 'L'], [-1, 'R'] */
		sides() { return [[1, 'L'], [-1, 'R']]; }
		/** Ramp (Roblox WedgePart): full height at local +y (back), sloping to the bottom edge at local -y (front). */
		wedge(c, s, k, bone, rot, R) {
			if (rot && !Array.isArray(rot)) { R = rot.R; rot = rot.rot; }
			this._push(c, s, k, bone, R || euler(...(rot || [0, 0, 0])), 'Wedge');
		}
		/** Wedge by ranges; the slope rises toward up = 'back' (+y) | 'front' | 'left' (+x) | 'right'. */
		ramp(y0, y1, x0, x1, z0, z1, k, bone, up) {
			const rz = { back: 0, front: 180, left: 90, right: -90 }[up || 'back'];
			let sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0);
			if (rz === 90 || rz === -90) [sx, sy] = [sy, sx];
			this.wedge([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [sx, sy, Math.abs(z1 - z0)], k, bone, [0, 0, rz]);
		}
		/** Cylinder from a to b, radius r (Roblox cylinder, axis = local x). */
		cyl(a, b, r, k, bone) {
			const x = norm(sub(b, a)), up = Math.abs(x[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
			const y = norm(cross(up, x)), z = cross(x, y);
			this._push(mulS(add(a, b), 0.5), [len(sub(b, a)), 2 * r, 2 * r], k, bone, fromCols(x, y, z), 'Cyl');
		}
		/** Rotation whose local z runs from a to c. */
		frame(a, c) {
			const z = norm(sub(c, a)), up = Math.abs(z[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
			const x = norm(cross(up, z)); return fromCols(x, cross(z, x), z);
		}
		/** Box from point a to point c with a w x d cross-section (tails, necks, tentacle segments). */
		limb(a, c, w, d, k, bone, extend) { this.box(mulS(add(a, c), 0.5), [w, d, len(sub(c, a)) + (extend || 0)], k, bone, null, this.frame(a, c)); }
		/** Tapering spike/horn: 3 boxes 1 / .66 / .36 wide; tip key on the last one. */
		spike(base, d, L, w, k, tip, bone) {
			d = norm(d); const R = fromTo([0, 0, 1], d);
			[[0, 0.45, 1], [0.45, 0.75, 0.66], [0.75, 1, 0.36]].forEach(([t0, t1, s], i) =>
				this.box(add(base, mulS(d, L * (t0 + t1) / 2)), [w * s, w * s, L * (t1 - t0) + 0.02], i === 2 ? tip : k, bone, null, R));
		}
		/** Stepped dome/egg: rows = [[half_width_frac, height]] from the bottom, keys per row. Returns the top z. */
		stack(y0, y1, w, z0, rows, keys, bone) {
			let z = z0;
			rows.forEach(([f, h], i) => { this.span(y0, y1, -w * f, w * f, z, z + h, keys[i], bone); z += h; });
			return z;
		}
		// ---------- poses ----------
		/** pose of a clip at a frame: { bone: [rx, ry, rz] world-axis degrees, root_loc: [x, y, z] metres } */
		poseAt(clip, frame) { const c = this.CLIPS[clip]; return c ? (c[1](frame) || {}) : {}; }
		/** per bone: local rotation (Roblox frame, row-major) and root translation in studs, for a pose object */
		rigPose(p) {
			const out = {};
			for (const [n] of this.BONES) out[n] = conjM(euler(...(p[n] || [0, 0, 0])));
			const rl = p.root_loc || [0, 0, 0];
			return { rot: out, rootLoc: mulS(toR(rl), this.STUDS) };
		}
		stats() {
			let tris = 0; for (const b of this.boxes) tris += b.shape === 'Cyl' ? 40 : b.shape === 'Wedge' ? 8 : 12;
			return { boxes: this.boxes.length, tris, bones: this.BONES.length, clips: Object.keys(this.CLIPS) };
		}
		/** Every voxel corner in rest pose (metres) for framing the camera. */
		bounds() {
			const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
			for (const b of this.boxes) for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
				const p = add(b.c, mv(b.R, [b.s[0] * sx, b.s[1] * sy, b.s[2] * sz]));
				for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
			}
			return { lo, hi };
		}
		// ---------- Roblox export (Data / Clips modules in the common ModelBuild contract, plus a ready .rbxmx) ----------
		_rbxBox(b) {
			const S = this.STUDS, pos = mulS(toR(b.c), S);
			if (b.shape === 'Box') return { size: mulS(b.s, S), pos, R: mm(M, b.R) };
			return { size: [b.s[0] * S, b.s[2] * S, b.s[1] * S], pos, R: conjM(b.R) };
		}
		_rbxBones() { return this.BONES.map(([n, h, , p]) => [n, p, mulS(toR(h), this.STUDS)]); }
		clipKeys(name) {
			const [L, fn] = this.CLIPS[name], keys = [];
			const n3 = x => (Math.abs(x) > 0.0005 ? +x.toFixed(3) : 0);
			for (let f = 0; f <= L; f += 2) {
				const rp = this.rigPose(fn(f) || {}), nums = [];
				for (const [n] of this.BONES) nums.push(...quat(rp.rot[n]));
				nums.push(...rp.rootLoc);
				keys.push([f, nums.map(n3)]);
			}
			return { length: L, keys };
		}
		toDataLuau() {
			const v3 = v => 'Vector3.new(' + v.map(a => a.toFixed(4)).join(', ') + ')';
			const L = ['-- ' + this.NAME + ' (generated by StudKit; build with ModelBuild)', 'return {', '\tScale = ' + this.STUDS + ',',
				'\tColors = {' + Object.entries(this.PALETTE).map(([k, v]) => k + ' = "' + v + '"').join(', ') + '},',
				'\tGlow = {' + [...this.GLOW].sort().map(k => k + ' = true').join(', ') + '},', '\tBones = {'];
			for (const [n, p, h] of this._rbxBones()) L.push('\t\t{ "' + n + '", ' + (p ? '"' + p + '"' : 'nil') + ', ' + v3(h) + ' },');
			L.push('\t},', '\tBoxes = {');
			for (const b of this.boxes) {
				const r = this._rbxBox(b), c = [0, 1, 2].map(j => [r.R[j], r.R[3 + j], r.R[6 + j]]);
				L.push('\t\t{ "' + b.bone + '", "' + b.k + '", ' + [r.size, r.pos, c[0], c[1], c[2]].map(v3).join(', ') + (b.shape !== 'Box' ? ', "' + b.shape + '"' : '') + ' },');
			}
			L.push('\t},', '\tFps = 30,', '}');
			return L.join('\n') + '\n';
		}
		toClipsLuau() {
			const L = ['-- ' + this.NAME + ' clips (generated by StudKit; play with StudAnimator)', 'return {', '\tFps = 30,',
				'\tBones = { ' + this.BONES.map(b => '"' + b[0] + '"').join(', ') + ' },', '\tClips = {'];
			for (const name of Object.keys(this.CLIPS)) {
				const c = this.clipKeys(name);
				L.push('\t\t' + name + ' = { Length = ' + c.length + ', Keys = {');
				for (const [f, v] of c.keys) L.push('\t\t\t{' + f + ',{' + v.join(',') + '}},');
				L.push('\t\t} },');
			}
			L.push('\t},', '}');
			return L.join('\n') + '\n';
		}
		/**
		 * .rbxmx: the built model (Root + bone parts + Motor6D in Joints + one Part per box, studs on every face, Neon for glow
		 * keys, welded to its bone part) plus ModuleScripts Clips + StudAnimator and a client Script "Animate" that loops a clip.
		 * @param o { animate: 'Idle' (clip the Animate script loops; null = no script), modules: true }
		 */
		toRbxmx(o) {
			o = Object.assign({ animate: Object.keys(this.CLIPS)[0] || null, modules: true }, o || {});
			const out = [], I = I3();
			const bones = this._rbxBones(), heads = {}, refs = {};
			out.push('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">');
			const rootRef = nextRef();
			out.push(`<Item class="Model" referent="${nextRef()}"><Properties><string name="Name">${esc(this.NAME)}</string><Ref name="PrimaryPart">${rootRef}</Ref>${attrXml({ StudKit: VERSION, Scale: this.STUDS })}</Properties>`);
			const part = (ref, name, cls, pos, R, size, col, mat, extra, anchored, transparent) =>
				`<Item class="${cls}" referent="${ref}"><Properties><string name="Name">${esc(name)}</string>` +
				`<bool name="Anchored">${anchored ? 'true' : 'false'}</bool><bool name="CanCollide">false</bool><bool name="CanQuery">false</bool><bool name="CanTouch">false</bool>` +
				`<bool name="Massless">true</bool>${cfXml('CFrame', pos, R)}${v3Xml('size', size)}` +
				`<Color3uint8 name="Color3uint8">${((0xff000000 | (col[0] << 16) | (col[1] << 8) | col[2]) >>> 0)}</Color3uint8>` +
				`<token name="Material">${MAT[mat]}</token><float name="Transparency">${transparent ? 1 : 0}</float>${extra || ''}</Properties>`;
			out.push(part(rootRef, 'Root', 'Part', [0, 0, 0], I, [1, 1, 1], [163, 162, 165], 'SmoothPlastic', '', true, true) + '</Item>');
			// bone parts + motors
			const motors = [];
			for (const [n, p, h] of bones) {
				heads[n] = h; refs[n] = nextRef();
				out.push(part(refs[n], 'B_' + n, 'Part', h, I, [0.4, 0.4, 0.4], [163, 162, 165], 'SmoothPlastic', '', false, true) + '</Item>');
				const c0 = sub(h, p ? heads[p] : [0, 0, 0]);
				motors.push(`<Item class="Motor6D" referent="${nextRef()}"><Properties><string name="Name">${esc(n)}</string>` +
					`${cfXml('C0', c0, I)}${cfXml('C1', [0, 0, 0], I)}<Ref name="Part0">${p ? refs[p] : rootRef}</Ref><Ref name="Part1">${refs[n]}</Ref>` +
					`${attrXml({ Parent: p || '', BaseC0: c0 })}</Properties></Item>`);
			}
			out.push(`<Item class="Folder" referent="${nextRef()}"><Properties><string name="Name">Joints</string></Properties>${motors.join('')}</Item>`);
			const studs = ['TopSurface', 'BottomSurface', 'FrontSurface', 'BackSurface', 'LeftSurface', 'RightSurface'].map(f => `<token name="${f}">3</token>`).join('');
			const smooth = ['TopSurface', 'BottomSurface'].map(f => `<token name="${f}">0</token>`).join('');
			for (const b of this.boxes) {
				const r = this._rbxBox(b), col = rgb(this.PALETTE[b.k]).map(v => Math.round(v * 255));
				const glow = this.GLOW.has(b.k), plain = this.NOSTUD.has(b.k);
				const mat = glow ? 'Neon' : plain ? 'SmoothPlastic' : 'Plastic';
				const ref = nextRef(), off = sub(r.pos, heads[b.bone]);
				const shape = b.shape === 'Cyl' ? '<token name="shape">2</token>' : '';
				out.push(part(ref, b.k, b.shape === 'Wedge' ? 'WedgePart' : 'Part', r.pos, r.R, r.size, col, mat,
					(mat === 'Plastic' ? studs : smooth) + shape + attrXml({ BaseSize: r.size }), false, false) +
					`<Item class="Weld" referent="${nextRef()}"><Properties><string name="Name">Weld</string>${cfXml('C0', off, r.R)}${cfXml('C1', [0, 0, 0], I)}` +
					`<Ref name="Part0">${refs[b.bone]}</Ref><Ref name="Part1">${ref}</Ref>${attrXml({ BaseOffset: off })}</Properties></Item></Item>`);
			}
			const script = (cls, name, src, extra) => `<Item class="${cls}" referent="${nextRef()}"><Properties><string name="Name">${name}</string>` +
				`<ProtectedString name="Source"><![CDATA[${src}]]></ProtectedString>${extra || ''}</Properties></Item>`;
			if (o.modules && Object.keys(this.CLIPS).length) {
				out.push(script('ModuleScript', 'Clips', this.toClipsLuau()));
				out.push(script('ModuleScript', 'StudAnimator', STUD_ANIMATOR));
				if (o.animate) out.push(script('Script', 'Animate', ANIMATE_SCRIPT.replace('@@CLIP@@', o.animate), '<token name="RunContext">2</token>'));
			}
			out.push('</Item></roblox>');
			return out.join('\n');
		}
	}

	// Luau played by the exported model (own implementation; plays Clips on the Motor6Ds in model.Joints)
	const STUD_ANIMATOR = `--!strict
-- StudAnimator: plays a StudKit Clips module on the Motor6Ds in model.Joints (client side, call :Step(dt) every frame).
-- local A = StudAnimator.new(model, require(model.Clips)); A:Play("Walk", true, 0.2); RunService.RenderStepped:Connect(function(dt) A:Step(dt) end)
local StudAnimator = {}
StudAnimator.__index = StudAnimator

function StudAnimator.new(model: Model, clips: any)
	local self = setmetatable({}, StudAnimator)
	self.Fps = clips.Fps or 30
	self.Motors = {}
	for _, m in (model:WaitForChild("Joints") :: Folder):GetChildren() do
		if m:IsA("Motor6D") then self.Motors[m.Name] = m end
	end
	self.Clips = {}
	local order = clips.Bones
	for name, clip in clips.Clips do
		local keys = {}
		for i, k in clip.Keys do
			local v, pose = k[2], {}
			for b, bone in order do
				local o = (b - 1) * 4
				pose[bone] = CFrame.new(0, 0, 0, v[o + 1], v[o + 2], v[o + 3], v[o + 4])
			end
			local r = #order * 4
			pose[order[1]] = CFrame.new(v[r + 1], v[r + 2], v[r + 3]) * pose[order[1]]
			keys[i] = { k[1], pose }
		end
		self.Clips[name] = { Length = clip.Length, Keys = keys }
	end
	self.Time, self.Speed, self.Fade, self.FadeT = 0, 1, 0, 0
	return self
end

function StudAnimator:Play(name: string, loop: boolean?, fade: number?): number
	local clip = self.Clips[name]
	assert(clip, "no clip " .. name)
	self.From = {}
	for bone, m in self.Motors do self.From[bone] = m.Transform end
	self.Clip, self.Loop, self.Time, self.Fade, self.FadeT = clip, loop ~= false, 0, fade or 0.2, 0
	return clip.Length / self.Fps
end

function StudAnimator:Step(dt: number)
	local clip = self.Clip
	if not clip then return end
	self.Time += dt * self.Speed
	local frame = self.Time * self.Fps
	if frame >= clip.Length then
		if self.Loop then frame %= clip.Length; self.Time = frame / self.Fps else frame = clip.Length end
	end
	local keys, a, b, u = clip.Keys, nil, nil, 0
	for i = 1, #keys - 1 do
		if frame <= keys[i + 1][1] then
			a, b = keys[i], keys[i + 1]
			u = math.clamp((frame - a[1]) / (b[1] - a[1]), 0, 1)
			break
		end
	end
	if not a then a, b = keys[#keys], keys[#keys] end
	self.FadeT += dt
	local f = if self.Fade > 0 then math.min(self.FadeT / self.Fade, 1) else 1
	for bone, m in self.Motors do
		local pa, pb = a[2][bone], b[2][bone]
		if pa and pb then
			local cf = pa:Lerp(pb, u)
			m.Transform = if f < 1 then self.From[bone]:Lerp(cf, f) else cf
		end
	end
end

return StudAnimator
`;
	const ANIMATE_SCRIPT = `-- Animate (RunContext = Client): loops one clip of this model in play mode. Delete this script to keep the model static.
local RunService = game:GetService("RunService")
local model = script.Parent
local StudAnimator = require(model:WaitForChild("StudAnimator"))
local anim = StudAnimator.new(model, require(model:WaitForChild("Clips")))
anim:Play("@@CLIP@@", true, 0)
RunService.RenderStepped:Connect(function(dt) anim:Step(dt) end)
`;

	// ================================================================ GRID (brick pipeline)
	class Grid {
		/**
		 * @param o { lo: [x,y,z], hi: [x,y,z] (design units, 1 brick each; centres at lo + .5 + i), id: 'Name',
		 *            studs: studs per brick (2.5 bosses, 2.5/R buildings), glow: {2: 'ff7a18', ...} (kind -> colour),
		 *            uvd: bricks per stud along a face (2 = one stud per 2x2 bricks) }
		 */
		constructor(o) {
			this.id = o.id || o.ID || 'Model';
			this.lo = o.lo.slice(); this.hi = o.hi.slice();
			this.n = [0, 1, 2].map(i => Math.round(this.hi[i] - this.lo[i]));
			const N = this.N = this.n[0] * this.n[1] * this.n[2];
			if (N > 6e6) throw new Error('Grid too big (' + N + ' cells): keep it under ~6 million');
			this.studs = o.studs || 2.5; this.uvd = o.uvd || 2;
			this.GLOW = {}; for (const k in (o.glow || {})) this.GLOW[k] = rgb(o.glow[k]);
			this.col = new Float32Array(N * 3); this.kind = new Uint8Array(N); this.stud = new Uint8Array(N); this.bone = new Int16Array(N);
			this.pid = new Int32Array(N); this.lvl = new Float32Array(N); this._nextId = 10;
			const [nx, ny, nz] = this.n;
			this.X = new Float32Array(N); this.Y = new Float32Array(N); this.Z = new Float32Array(N); this.AX = new Float32Array(N);
			for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
				const q = (i * ny + j) * nz + k;
				this.X[q] = this.lo[0] + 0.5 + i; this.Y[q] = this.lo[1] + 0.5 + j; this.Z[q] = this.lo[2] + 0.5 + k; this.AX[q] = Math.abs(this.X[q]);
			}
			this.RIG = null; this.lights = [];
		}
		idx(i, j, k) { return (i * this.n[1] + j) * this.n[2] + k; }
		// ---------- fields (Float32Array signed distances) ----------
		field(fn) { const f = new Float32Array(this.N); for (let q = 0; q < this.N; q++) f[q] = fn(this.X[q], this.Y[q], this.Z[q], q); return f; }
		/** ellipsoid signed distance (iq's estimate): centre c, radii r */
		ell(c, r) {
			const f = new Float32Array(this.N);
			for (let q = 0; q < this.N; q++) {
				const px = (this.X[q] - c[0]) / r[0], py = (this.Y[q] - c[1]) / r[1], pz = (this.Z[q] - c[2]) / r[2];
				const k0 = Math.sqrt(px * px + py * py + pz * pz), k1 = Math.sqrt((px / r[0]) ** 2 + (py / r[1]) ** 2 + (pz / r[2]) ** 2) + 1e-9;
				f[q] = k0 * (k0 - 1) / k1;
			}
			return f;
		}
		/** same as ell but mirrored in x (uses |x|): one call for a left/right pair */
		ellSym(c, r) { const f = this.ell(c, r), g = this.ell([-c[0], c[1], c[2]], r); for (let q = 0; q < this.N; q++) f[q] = Math.min(f[q], g[q]); return f; }
		/** smooth union of two fields (k = blend width in bricks) */
		smin(a, b, k) {
			const f = new Float32Array(this.N);
			for (let q = 0; q < this.N; q++) { const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b[q] - a[q]) / k)); f[q] = b[q] + (a[q] - b[q]) * h - k * h * (1 - h); }
			return f;
		}
		/** smooth subtraction: a minus b */
		ssub(a, b, k) {
			const f = new Float32Array(this.N);
			for (let q = 0; q < this.N; q++) { const h = Math.max(0, Math.min(1, 0.5 - 0.5 * (a[q] + b[q]) / k)); f[q] = a[q] + (-b[q] - a[q]) * h + k * h * (1 - h); }
			return f;
		}
		// ---------- masks (Uint8Array) ----------
		mask(fn) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) m[q] = fn(this.X[q], this.Y[q], this.Z[q], q) ? 1 : 0; return m; }
		lt(f, v) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) m[q] = f[q] < v ? 1 : 0; return m; }
		gt(f, v) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) m[q] = f[q] > v ? 1 : 0; return m; }
		and(...ms) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) { let v = 1; for (const a of ms) if (!a[q]) { v = 0; break; } m[q] = v; } return m; }
		or(...ms) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) { let v = 0; for (const a of ms) if (a[q]) { v = 1; break; } m[q] = v; } return m; }
		not(a) { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) m[q] = a[q] ? 0 : 1; return m; }
		solid() { const m = new Uint8Array(this.N); for (let q = 0; q < this.N; q++) m[q] = this.kind[q] > 0 ? 1 : 0; return m; }
		/** box mask, symmetric in x (uses |x|) like the numpy examples; boxA() is the plain version */
		box(x0, x1, y0, y1, z0, z1) { return this.mask((x, y, z, q) => this.AX[q] > x0 && this.AX[q] < x1 && y > y0 && y < y1 && z > z0 && z < z1); }
		boxA(x0, x1, y0, y1, z0, z1) { return this.mask((x, y, z) => x > x0 && x < x1 && y > y0 && y < y1 && z > z0 && z < z1); }
		/** capsule from a to b, radius ra -> rb */
		cap(a, b, ra, rb) {
			const ab = sub(b, a), L2 = dot(ab, ab) || 1;
			return this.mask((x, y, z) => {
				const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / L2));
				const dx = x - a[0] - ab[0] * t, dy = y - a[1] - ab[1] * t, dz = z - a[2] - ab[2] * t;
				return dx * dx + dy * dy + dz * dz <= (ra + (rb - ra) * t) ** 2;
			});
		}
		/** chain of capsules through points with radii (tails, tentacles, necks) */
		chain(pts, radii) { let m = new Uint8Array(this.N); for (let i = 0; i < pts.length - 1; i++) m = this.or(m, this.cap(pts[i], pts[i + 1], radii[i], radii[i + 1])); return m; }
		/** rounded-square column section at (|x|, z) (legs, posts) */
		col4(x, z, hx, hz) { return this.mask((X, Y, Z, q) => ((this.AX[q] - x) / hx) ** 4 + ((Z - z) / hz) ** 4 < 1); }
		/** cylinder mask along y, symmetric in x when sym */
		cylY(x, z, r, y0, y1, sym) { return this.mask((X, Y, Z, q) => Y > y0 && Y < y1 && ((sym ? this.AX[q] : X) - x) ** 2 + (Z - z) ** 2 < r * r); }
		// ---------- painting ----------
		/**
		 * Paint cells: colour = hex | [r,g,b] 0..1 | fn(x, y, z, q) -> colour.
		 * o = { k: 1 solid / 2+ glow kind, st: studs on (default true), p: plate id (g.newid()), l: plate level (higher plates
		 *       overlap lower ones; g.seams() darkens the lower side), bone }. Later put() wins (paint eyes after the head).
		 */
		put(m, colour, o) {
			o = o || {};
			const k = o.k === undefined ? 1 : o.k, st = o.st === undefined ? 1 : (o.st ? 1 : 0), fnc = typeof colour === 'function';
			const c = fnc ? null : rgb(colour), bi = o.bone === undefined ? -1 : this._boneIndex(o.bone);
			const p = o.p === undefined ? 0 : o.p, l = o.l === undefined ? 0 : o.l;
			for (let q = 0; q < this.N; q++) {
				if (!m[q]) continue;
				const cc = fnc ? rgb(colour(this.X[q], this.Y[q], this.Z[q], q)) : c;
				this.col[q * 3] = cc[0]; this.col[q * 3 + 1] = cc[1]; this.col[q * 3 + 2] = cc[2];
				this.kind[q] = k; this.stud[q] = st && k === 1 ? 1 : 0; this.pid[q] = p; this.lvl[q] = l;
				if (bi >= 0) this.bone[q] = bi;
			}
		}
		/** a fresh plate id for put(..., { p: g.newid(), l: level }) */
		newid() { return ++this._nextId; }
		/** colour multiply helper: c * f (hex or [r,g,b]) -> [r,g,b] */
		mul(c, f) { return rgb(c).map(v => Math.min(1, v * f)); }
		/**
		 * Plate seams: where two plates touch, the LOWER one (smaller level; same level -> smaller id) darkens by f, so every
		 * plate edge reads as a real step (the War Rhino look). Call after all plates are placed.
		 */
		seams(f) {
			f = f === undefined ? 0.5 : f;
			const [nx, ny, nz] = this.n, dark = new Uint8Array(this.N);
			for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
				const q = this.idx(i, j, k), p = this.pid[q]; if (!p || this.kind[q] !== 1) continue;
				for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
					const I = (i + a + nx) % nx, J = (j + b + ny) % ny, K = (k + c + nz) % nz, r = this.idx(I, J, K), pr = this.pid[r];
					if (pr > 0 && pr !== p && (this.lvl[r] > this.lvl[q] || (this.lvl[r] === this.lvl[q] && pr > p))) { dark[q] = 1; break; }
				}
			}
			for (let q = 0; q < this.N; q++) if (dark[q]) for (let c = 0; c < 3; c++) this.col[q * 3 + c] *= f;
		}
		/** light from above: colour *= clamp(a + b * y / h, lo, hi) (lit tops, dark underside) */
		lightY(a, b, h, lo, hi) {
			for (let q = 0; q < this.N; q++) if (this.kind[q] === 1) {
				const f = Math.max(lo === undefined ? 0.62 : lo, Math.min(hi === undefined ? 1.18 : hi, a + b * this.Y[q] / h));
				for (let c = 0; c < 3; c++) this.col[q * 3 + c] = Math.min(1, this.col[q * 3 + c] * f);
			}
		}
		/** snap every solid brick to the nearest colour of a fixed palette (keep it <= 16) */
		snapTo(pal) {
			const P = pal.map(rgb);
			for (let q = 0; q < this.N; q++) if (this.kind[q] === 1) {
				let best = 0, bd = 1e9;
				for (let i = 0; i < P.length; i++) { const d = (P[i][0] - this.col[q * 3]) ** 2 + (P[i][1] - this.col[q * 3 + 1]) ** 2 + (P[i][2] - this.col[q * 3 + 2]) ** 2; if (d < bd) { bd = d; best = i; } }
				this.col.set(P[best], q * 3);
			}
		}
		/** y of the highest solid brick centre in the column nearest to (x, z), or null */
		topY(x, z) {
			const i = Math.round(x - this.lo[0] - 0.5), k = Math.round(z - this.lo[2] - 0.5);
			if (i < 0 || k < 0 || i >= this.n[0] || k >= this.n[2]) return null;
			for (let j = this.n[1] - 1; j >= 0; j--) if (this.kind[this.idx(i, j, k)]) return this.lo[1] + 0.5 + j;
			return null;
		}
		clear(m) { for (let q = 0; q < this.N; q++) if (m[q]) this.kind[q] = 0; }
		/** multiply the colour of solid cells by f (number or fn(x,y,z,q)) where mask m is set (seams, shading bands) */
		shade(m, f) { for (let q = 0; q < this.N; q++) if (m[q] && this.kind[q] === 1) { const v = typeof f === 'function' ? f(this.X[q], this.Y[q], this.Z[q], q) : f; for (let c = 0; c < 3; c++) this.col[q * 3 + c] = Math.min(1, this.col[q * 3 + c] * v); } }
		/** surface shell: solid cells with an empty 6-neighbour (paint only what is visible) */
		surface() {
			const [nx, ny, nz] = this.n, m = new Uint8Array(this.N);
			for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
				const q = this.idx(i, j, k); if (!this.kind[q]) continue;
				const e = (a, b, c) => a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz || !this.kind[this.idx(a, b, c)];
				if (e(i - 1, j, k) || e(i + 1, j, k) || e(i, j - 1, k) || e(i, j + 1, k) || e(i, j, k - 1) || e(i, j, k + 1)) m[q] = 1;
			}
			return m;
		}
		/** keep only the biggest 26-connected piece (nothing floats). keep = mask of cells to keep anyway (smoke, coins). */
		dropFloating(keep) {
			const [nx, ny, nz] = this.n, lab = new Int32Array(this.N), sizes = [0];
			const stack = new Int32Array(this.N); let id = 0;
			for (let s = 0; s < this.N; s++) {
				if (!this.kind[s] || lab[s]) continue;
				id++; let sp = 0, cnt = 0; stack[sp++] = s; lab[s] = id;
				while (sp) {
					const q = stack[--sp]; cnt++;
					const i = Math.floor(q / (ny * nz)), j = Math.floor(q / nz) % ny, k = q % nz;
					for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
						const I = i + a, J = j + b, K = k + c;
						if (I < 0 || J < 0 || K < 0 || I >= nx || J >= ny || K >= nz) continue;
						const r = (I * ny + J) * nz + K;
						if (this.kind[r] && !lab[r]) { lab[r] = id; stack[sp++] = r; }
					}
				}
				sizes.push(cnt);
			}
			let best = 1; for (let i = 2; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
			let removed = 0;
			for (let q = 0; q < this.N; q++) if (this.kind[q] && lab[q] !== best && !(keep && keep[q])) { this.kind[q] = 0; removed++; }
			return removed;
		}
		/** a point light for the preview (glowing eyes, cores): pos in design units, colour */
		light(pos, colour, strength) { this.lights.push({ pos, colour: rgb(colour), strength: strength || 1 }); }
		count() { let c = 0; for (let q = 0; q < this.N; q++) if (this.kind[q]) c++; return c; }
		/** how many distinct solid colours (keep it <= 16 for the clean look) */
		palette() { const s = new Set(); for (let q = 0; q < this.N; q++) if (this.kind[q] === 1) s.add(hexOf([this.col[q * 3], this.col[q * 3 + 1], this.col[q * 3 + 2]])); return [...s]; }
		/** snap every solid colour to the nearest of the k most used ones (the reference keeps <= 16 colours) */
		snapPalette(k) {
			k = k || 16; const cnt = new Map();
			for (let q = 0; q < this.N; q++) if (this.kind[q] === 1) { const h = hexOf([this.col[q * 3], this.col[q * 3 + 1], this.col[q * 3 + 2]]); cnt.set(h, (cnt.get(h) || 0) + 1); }
			const pal = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(e => rgb(e[0]));
			for (let q = 0; q < this.N; q++) if (this.kind[q] === 1) {
				let best = 0, bd = 1e9;
				pal.forEach((p, i) => { const d = (p[0] - this.col[q * 3]) ** 2 + (p[1] - this.col[q * 3 + 1]) ** 2 + (p[2] - this.col[q * 3 + 2]) ** 2; if (d < bd) { bd = d; best = i; } });
				this.col.set(pal[best], q * 3);
			}
			return pal.length;
		}
		// ---------- rig ----------
		_boneIndex(name) { if (!this.RIG) throw new Error('call g.rig(...) before using bones'); const i = this.RIG.findIndex(b => b[0] === name); if (i < 0) throw new Error('unknown bone ' + name); return i; }
		/**
		 * Bones for a boss: RIG = [[bone, parent, head, tail], ...] in design units, root first. Every solid cell goes to the
		 * nearest bone segment; overrides = [[mask, bone], ...] fix the misses (applied in order, last wins).
		 */
		rig(RIG, overrides) {
			this.RIG = RIG.map(b => [b[0], b[1] || null, b[2].slice(), b[3].slice()]);
			const segs = this.RIG.map(b => [b[2], sub(b[3], b[2])]);
			for (let q = 0; q < this.N; q++) {
				if (!this.kind[q]) continue;
				const p = [this.X[q], this.Y[q], this.Z[q]]; let best = 0, bd = 1e18;
				segs.forEach(([a, ab], i) => {
					if (this.RIG[i][0] === 'root' && RIG.length > 1) return;
					const L2 = dot(ab, ab), t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
					const d = sub(p, add(a, mulS(ab, t))), dd = dot(d, d); if (dd < bd) { bd = dd; best = i; }
				});
				this.bone[q] = best;
			}
			for (const [m, b] of overrides || []) { const bi = this._boneIndex(b); for (let q = 0; q < this.N; q++) if (m[q] && this.kind[q]) this.bone[q] = bi; }
			return this;
		}
		// ---------- meshing ----------
		/**
		 * Greedy-merged exposed faces, one piece per bone (and per glow kind). Returns
		 * [{ bone, glow, positions (studs, design axes), normals, colors (linear), uvs (stud units), studOn, indices }].
		 */
		mesh() {
			const [nx, ny, nz] = this.n, S = this.studs, n = this.n, pieces = new Map();
			const keyOf = q => {
				const k = this.kind[q];
				const c = k >= 2 ? (this.GLOW[k] || [1, 0.6, 0.2]) : [this.col[q * 3], this.col[q * 3 + 1], this.col[q * 3 + 2]];
				return { k, c, st: this.stud[q], bone: this.RIG ? this.bone[q] : 0, key: (k >= 2 ? 'g' + k : 'c' + hexOf(c) + this.stud[q]) + '|' + (this.RIG ? this.bone[q] : 0) };
			};
			const piece = (bone, glow) => {
				const id = bone + '|' + glow;
				if (!pieces.has(id)) pieces.set(id, { bone, glow, P: [], N: [], C: [], U: [], T: [], I: [] });
				return pieces.get(id);
			};
			const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && this.kind[(i * ny + j) * nz + k] > 0;
			for (let d = 0; d < 3; d++) {
				const u = (d + 1) % 3, v = (d + 2) % 3;
				for (const dir of [1, -1]) {
					const cell = new Array(n[u] * n[v]);
					for (let s = 0; s < n[d]; s++) {
						cell.fill(null);
						for (let a = 0; a < n[u]; a++) for (let b = 0; b < n[v]; b++) {
							const ijk = [0, 0, 0]; ijk[d] = s; ijk[u] = a; ijk[v] = b;
							const q = (ijk[0] * ny + ijk[1]) * nz + ijk[2];
							if (!this.kind[q]) continue;
							const nb = ijk.slice(); nb[d] += dir;
							if (solid(nb[0], nb[1], nb[2])) continue;
							cell[a * n[v] + b] = keyOf(q);
						}
						for (let a = 0; a < n[u]; a++) for (let b = 0; b < n[v]; b++) {
							const c0 = cell[a * n[v] + b]; if (!c0) continue;
							let w = 1; while (b + w < n[v] && cell[a * n[v] + b + w] && cell[a * n[v] + b + w].key === c0.key) w++;
							let h = 1;
							grow: while (a + h < n[u]) { for (let t = 0; t < w; t++) { const cc = cell[(a + h) * n[v] + b + t]; if (!cc || cc.key !== c0.key) break grow; } h++; }
							for (let r = 0; r < h; r++) for (let t = 0; t < w; t++) cell[(a + r) * n[v] + b + t] = null;
							const pc = piece(c0.bone, c0.k >= 2 ? c0.k : 0), base = pc.P.length / 3;
							const plane = this.lo[d] + s + (dir > 0 ? 1 : 0);
							const corner = (da, db) => { const p = [0, 0, 0]; p[d] = plane; p[u] = this.lo[u] + a + da; p[v] = this.lo[v] + b + db; return p; };
							const quad = dir > 0 ? [[0, 0], [h, 0], [h, w], [0, w]] : [[0, 0], [0, w], [h, w], [h, 0]];
							const nrm = [0, 0, 0]; nrm[d] = dir;
							const lc = c0.c.map(lin);
							for (const [da, db] of quad) {
								const p = corner(da, db);
								pc.P.push(p[0] * S, p[1] * S, p[2] * S); pc.N.push(...nrm); pc.C.push(...lc);
								pc.U.push(p[u] / this.uvd, p[v] / this.uvd); pc.T.push(c0.st && c0.k === 1 ? 1 : 0);
							}
							pc.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
						}
					}
				}
			}
			return [...pieces.values()].map(p => ({ bone: p.bone, glow: p.glow, positions: new Float32Array(p.P), normals: new Float32Array(p.N), colors: new Float32Array(p.C), uvs: new Float32Array(p.U), studOn: new Float32Array(p.T), indices: new Uint32Array(p.I) }));
		}
		stats() { let t = 0; const m = this.mesh(); for (const p of m) t += p.indices.length / 3; return { bricks: this.count(), tris: t, pieces: m.length, colours: this.palette().length }; }
		/**
		 * glTF binary for Roblox (Avatar / 3D Importer): Y up, studs, vertex colours (COLOR_0) x stud texture (pass the PNG bytes
		 * from StudViewer.studPNG()), glow pieces emissive (set them to Neon in Studio). Pieces split to <= 20k triangles.
		 * With a rig: skinned, one joint per bone, rigid weights. Roblox turns GLBs 180 deg about Y on import.
		 */
		toGLB(studPng) {
			const meshes = this.mesh(), S = this.studs;
			const json = { asset: { version: '2.0', generator: 'StudKit ' + VERSION }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: this.id, children: [] }], meshes: [], materials: [], accessors: [], bufferViews: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] };
			const chunks = []; let offset = 0;
			const view = (arr, target) => {
				const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
				json.bufferViews.push(Object.assign({ buffer: 0, byteOffset: offset, byteLength: bytes.length }, target ? { target } : {}));
				chunks.push(bytes); offset += bytes.length;
				const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
				return json.bufferViews.length - 1;
			};
			const acc = (arr, type, ct, target, extra) => { json.accessors.push(Object.assign({ bufferView: view(arr, target), componentType: ct, count: arr.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], type }, extra || {})); return json.accessors.length - 1; };
			let texIndex = null;
			if (studPng) { json.images = [{ bufferView: view(studPng), mimeType: 'image/png', name: 'stud_mul' }]; json.textures = [{ sampler: 0, source: 0 }]; texIndex = 0; }
			json.materials.push(Object.assign({ name: 'Stud', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }, texIndex !== null ? { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.6 } } : {}));
			const glowMat = {};
			const rigged = !!this.RIG, joints = [];
			if (rigged) {
				this.RIG.forEach(([n, p, h]) => {
					const ph = p ? this.RIG.find(b => b[0] === p)[2] : [0, 0, 0];
					json.nodes.push({ name: n, translation: mulS(sub(h, ph), S) });
					joints.push(json.nodes.length - 1);
				});
				this.RIG.forEach(([, p], i) => { const parent = p ? joints[this.RIG.findIndex(b => b[0] === p)] : 0; (json.nodes[parent].children = json.nodes[parent].children || []).push(joints[i]); });
				const ibm = new Float32Array(16 * this.RIG.length);
				this.RIG.forEach(([, , h], i) => { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -h[0] * S, -h[1] * S, -h[2] * S, 1], i * 16); });
				json.skins = [{ joints, inverseBindMatrices: acc(ibm, 'MAT4', 5126), skeleton: joints[0] }];
			}
			// split into <= 20k triangle chunks (whole quads)
			const MAXT = 19998, prims = [];
			for (const m of meshes) {
				const quads = m.indices.length / 6;
				for (let q0 = 0; q0 < quads; q0 += MAXT / 2) {
					const q1 = Math.min(quads, q0 + MAXT / 2), v0 = q0 * 4, v1 = q1 * 4;
					const sl = (a, k) => a.slice(v0 * k, v1 * k);
					const P = sl(m.positions, 3), Nn = sl(m.normals, 3), C = sl(m.colors, 3), U = sl(m.uvs, 2);
					const idx = new Uint32Array((q1 - q0) * 6); for (let i = 0; i < idx.length; i++) idx[i] = m.indices[q0 * 6 + i] - v0;
					// stud gate baked into the colour: plain faces keep their colour, studded faces use the stud texture UV, plain faces a flat texel
					for (let i = 0; i < (v1 - v0); i++) if (!m.studOn[v0 + i]) { U[i * 2] = 0.02; U[i * 2 + 1] = 0.02; }
					const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
					for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]); }
					const C4 = new Float32Array((C.length / 3) * 4); for (let i = 0; i < C.length / 3; i++) C4.set([C[i * 3], C[i * 3 + 1], C[i * 3 + 2], 1], i * 4);
					const attrs = { POSITION: acc(P, 'VEC3', 5126, 34962, { min, max }), NORMAL: acc(Nn, 'VEC3', 5126, 34962), COLOR_0: acc(C4, 'VEC4', 5126, 34962), TEXCOORD_0: acc(U, 'VEC2', 5126, 34962) };
					if (rigged) {
						const J = new Uint16Array((P.length / 3) * 4), W = new Float32Array((P.length / 3) * 4);
						for (let i = 0; i < P.length / 3; i++) { J[i * 4] = m.bone; W[i * 4] = 1; }
						attrs.JOINTS_0 = acc(J, 'VEC4', 5123, 34962); attrs.WEIGHTS_0 = acc(W, 'VEC4', 5126, 34962);
					}
					let mat = 0;
					if (m.glow) {
						if (!(m.glow in glowMat)) { const g = (this.GLOW[m.glow] || [1, 0.6, 0.2]).map(lin); json.materials.push({ name: 'Glow' + m.glow, emissiveFactor: g, pbrMetallicRoughness: { baseColorFactor: [...g, 1], metallicFactor: 0, roughnessFactor: 1 } }); glowMat[m.glow] = json.materials.length - 1; }
						mat = glowMat[m.glow];
					}
					prims.push({ name: (rigged ? this.RIG[m.bone][0] : this.id) + (m.glow ? '_glow' : '') + '_' + (q0 / (MAXT / 2)), prim: { attributes: attrs, indices: acc(idx, 'SCALAR', 5125, 34963), material: mat } });
				}
			}
			for (const p of prims) {
				json.meshes.push({ name: p.name, primitives: [p.prim] });
				json.nodes.push(Object.assign({ name: p.name, mesh: json.meshes.length - 1 }, rigged ? { skin: 0 } : {}));
				json.nodes[0].children.push(json.nodes.length - 1);
			}
			json.buffers = [{ byteLength: offset }];
			return glbPack(json, chunks, offset);
		}
	}
	// pack a glTF binary (MAT4 accessor counts fixed up: 16 floats per element)
	function glbPack(json, chunks, offset) {
		for (const a of json.accessors) if (a.type === 'MAT4') a.count = json.bufferViews[a.bufferView].byteLength / 64;
		const enc = new TextEncoder(); let jb = enc.encode(JSON.stringify(json));
		const jpad = (4 - (jb.length % 4)) % 4; if (jpad) { const t = new Uint8Array(jb.length + jpad); t.set(jb); t.fill(0x20, jb.length); jb = t; }
		const total = 12 + 8 + jb.length + 8 + offset, out = new Uint8Array(total), dv = new DataView(out.buffer);
		dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
		dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
		let p = 20 + jb.length; dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
		for (const c of chunks) { out.set(c, p); p += c.length; }
		return out;
	}

	// ================================================================ BUILDING (bld.py)
	const PATS = { '': 0, plank: 1, stone: 2, shingle: 3, log: 4 };
	class Building {
		/** Big shapes in UNITS (1 unit = 2.5 studs) on an nx x ny x nz grid (x and z centred, y from 0), details in fine bricks (R per unit). */
		constructor(nx, ny, nz, o) {
			o = typeof o === 'number' ? { R: o } : (o || {});
			this.R = o.R || 3; this.n = [nx, ny, nz]; this.id = o.id || 'Building'; this.glow = o.glow || {};
			const N = nx * ny * nz; this.kind = new Uint8Array(N); this.col = new Float32Array(N * 3); this.pat = new Uint8Array(N);
			this.fine = [];
		}
		_range(x0, x1, y0, y1, z0, z1, f) {
			const cx = Math.floor(this.n[0] * f / 2), cz = Math.floor(this.n[2] * f / 2), N = this.n.map(v => v * f);
			return [Math.max(cx + x0, 0), Math.min(cx + x1, N[0]), Math.max(y0, 0), Math.min(y1, N[1]), Math.max(cz + z0, 0), Math.min(cz + z1, N[2])];
		}
		_each(r, n, fn) { for (let i = r[0]; i < r[1]; i++) for (let j = r[2]; j < r[3]; j++) for (let k = r[4]; k < r[5]; k++) fn((i * n[1] + j) * n[2] + k); }
		box(x0, x1, y0, y1, z0, z1, c, k, pat) {
			const col = rgb(c), kk = k === undefined ? 1 : k, pt = PATS[pat || ''];
			if (pt === undefined) throw new Error('pattern must be plank | stone | shingle | log');
			this._each(this._range(x0, x1, y0, y1, z0, z1, 1), this.n, q => { this.kind[q] = kk; this.col.set(col, q * 3); this.pat[q] = pt; });
		}
		cut(x0, x1, y0, y1, z0, z1) { this._each(this._range(x0, x1, y0, y1, z0, z1, 1), this.n, q => { this.kind[q] = 0; }); }
		fbox(x0, x1, y0, y1, z0, z1, c, k) { this.fine.push(['box', [x0, x1, y0, y1, z0, z1], rgb(c), k === undefined ? 1 : k]); }
		fcut(x0, x1, y0, y1, z0, z1) { this.fine.push(['cut', [x0, x1, y0, y1, z0, z1], null, 0]); }
		/** organic shape in fine bricks: fn(x, y, z) -> bool (x/z centred, y up); c = colour or fn(x, y, z) -> colour */
		fshape(fn, c, k) { this.fine.push(['shape', fn, c, k === undefined ? 1 : k]); }
		/** leafy clump / boulder: ellipsoid with a lumpy surface (never a smooth sphere) */
		blob(cx, cy, cz, rx, ry, rz, c, k, lumpy, seed) {
			const L = lumpy === undefined ? 0.18 : lumpy, sd = seed || 0;
			this.fshape((x, y, z) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 < 1 + L * Math.sin(x * 0.9 + sd) * Math.sin(y * 0.7 + 2 * sd) * Math.sin(z * 0.8 + 3 * sd), c, k);
		}
		/** front-facing window in fine bricks, zf = fine z of the wall's outer layer: recessed glowing pane, frame, cross mullion, sill */
		window(x0, x1, y0, y1, zf, frame, glow, sill) {
			const g = glow === undefined ? 2 : glow;
			this.fcut(x0, x1, y0, y1, zf, zf + 2);
			this.fbox(x0, x1, y0, y1, zf + 2, zf + 3, '000000', g);
			for (const a of [[x0 - 1, x0, y0 - 1, y1 + 1], [x1, x1 + 1, y0 - 1, y1 + 1], [x0 - 1, x1 + 1, y1, y1 + 1]]) this.fbox(a[0], a[1], a[2], a[3], zf - 1, zf, frame);
			const mx = Math.floor((x0 + x1) / 2), my = Math.floor((y0 + y1) / 2);
			this.fbox(mx, mx + 1, y0, y1, zf + 1, zf + 2, frame); this.fbox(x0, x1, my, my + 1, zf + 1, zf + 2, frame);
			this.fbox(x0 - 1, x1 + 1, y0 - 1, y0, zf - 2, zf, sill === undefined ? frame : sill);
		}
		/** stepped flame (wide base, narrow tip, glowing core) for torches and braziers, fine bricks */
		flame(cx, cy, cz, h, w, colours, glowKind) {
			const cs = colours || ['ff7a1a', 'ffb347'];
			for (let i = 0; i < h; i++) { const r = Math.max(1, Math.round(w * Math.pow(1 - i / h, 0.7))); this.fbox(cx - r, cx + r, cy + i, cy + i + 1, cz - r, cz + r, i < h * 0.5 ? cs[0] : cs[1]); }
			this.fbox(cx - 1, cx + 1, cy, cy + Math.floor(h / 2), cz - 1, cz + 1, '000000', glowKind || 2);
		}
		/** the fine-brick Grid (patterns carved, fine details applied, light from above) */
		toGrid() {
			const R = this.R, N = this.n.map(v => v * R), [nx, ny, nz] = this.n;
			const g = new Grid({ id: this.id, lo: [-N[0] / 2, 0, -N[2] / 2], hi: [N[0] / 2, N[1], N[2] / 2], studs: 2.5 / R, uvd: 2, glow: this.glow });
			for (let i = 0; i < N[0]; i++) for (let j = 0; j < N[1]; j++) for (let k = 0; k < N[2]; k++) {
				const s = (Math.floor(i / R) * ny + Math.floor(j / R)) * nz + Math.floor(k / R), q = g.idx(i, j, k);
				if (!this.kind[s]) continue;
				g.kind[q] = this.kind[s]; g.stud[q] = this.kind[s] === 1 ? 1 : 0;
				let mul = 1; const pat = this.pat[s], row = Math.floor(j / R), fy = j % R;
				if (pat === 1 && fy === 0) mul = 0.78;
				if (pat === 2) { const bx = Math.floor((i + k + (row % 2) * R) / (2 * R)); const seam = fy === 0 || (i + k + (row % 2) * R) % (2 * R) === 0; mul = seam ? 0.72 : 1 + 0.05 * Math.sin(bx * 2.3 + row * 1.7); }
				if (pat === 3) { const tab = (i + k + (row % 2) * R) % (2 * R) === 0; mul = tab ? 0.8 : [0.72, 0.9, 1.04][Math.min(fy, 2)]; }
				if (pat === 4 && (fy === 0 || fy === R - 1)) mul = 0.82;
				for (let c = 0; c < 3; c++) g.col[q * 3 + c] = this.col[s * 3 + c] * mul;
			}
			const cx = N[0] / 2, cz = N[2] / 2;
			for (const [op, r, c, k] of this.fine) {
				if (op === 'shape') {
					for (let q = 0; q < g.N; q++) {
						const x = g.X[q], y = g.Y[q], z = g.Z[q];
						if (!r(x, y, z)) continue;
						g.kind[q] = k; g.stud[q] = k === 1 ? 1 : 0;
						g.col.set(typeof c === 'function' ? rgb(c(x, y, z)) : rgb(c), q * 3);
					}
					continue;
				}
				const rr = [Math.max(cx + r[0], 0), Math.min(cx + r[1], N[0]), Math.max(r[2], 0), Math.min(r[3], N[1]), Math.max(cz + r[4], 0), Math.min(cz + r[5], N[2])];
				for (let i = rr[0]; i < rr[1]; i++) for (let j = rr[2]; j < rr[3]; j++) for (let kk = rr[4]; kk < rr[5]; kk++) {
					const q = g.idx(i, j, kk);
					if (op === 'cut') { g.kind[q] = 0; continue; }
					g.kind[q] = k; g.stud[q] = k === 1 ? 1 : 0; g.col.set(c, q * 3);
				}
			}
			for (let q = 0; q < g.N; q++) if (g.kind[q] === 1) { const f = 0.9 + 0.18 * g.Y[q] / Math.max(N[1], 1); for (let c = 0; c < 3; c++) g.col[q * 3 + c] = Math.min(1, g.col[q * 3 + c] * f); }
			return g;
		}
	}

	// ================================================================ shared colour helpers for recipes
	/** one hue in 4 tones with fixed jobs: [light tops, main, side steps, dark underside] */
	function tones(c, spread) {
		const k = spread || 1, b = rgb(c);
		return [1.18, 1, 0.86, 0.68].map(f => hexOf(b.map(v => Math.min(1, v * (1 + (f - 1) * k)))));
	}
	const hx = rgb;

	/** piecewise linear interpolation like numpy.interp: xs ascending */
	function interp(x, xs, ys) {
		if (x <= xs[0]) return ys[0];
		for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + (ys[i] - ys[i - 1]) * t; }
		return ys[ys.length - 1];
	}

	return { VERSION, Creature, Grid, Building, euler, fromTo, quat, rgb, hx, hexOf, tones, lin, interp, TAU, conjM, toR, M };
});
