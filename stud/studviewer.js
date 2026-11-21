/*
 * StudViewer: 3D preview for StudKit models (three.js r128 + OrbitControls must be loaded first).
 * The page defines  function build(StudKit) { ...; return model; }  (a StudKit.Creature, Grid or Building).
 * Shows the model with the square Roblox stud texture, ONE black silhouette outline, glow on glow keys, views like the
 * classic turnaround sheets (front, 3/4, side, back), plays the clips, and offers the downloads (.rbxmx / .luau / .glb / .png).
 */
(function () {
	'use strict';
	const NL = String.fromCharCode(10);
	const css = `
	html,body{margin:0;height:100%;overflow:hidden;background:#bfe3c6;font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17201a}
	#sv-wrap{position:fixed;inset:0}
	#sv-wrap canvas{display:block}
	.sv-panel{position:fixed;background:rgba(255,255,255,.88);border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.12);padding:10px 12px}
	#sv-info{left:12px;top:12px;max-width:min(360px,calc(100vw - 48px))}
	#sv-info h1{font-size:16px;margin:0 0 4px}
	#sv-info .sv-stats{opacity:.75;font-size:12px}
	#sv-bar{left:12px;bottom:12px;right:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
	#sv-bar .sv-group{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-right:8px}
	#sv-bar .sv-label{font-size:11px;opacity:.6;margin-right:2px;text-transform:uppercase;letter-spacing:.04em}
	.sv-btn{border:0;border-radius:8px;padding:6px 10px;background:#e6efe8;color:#17201a;cursor:pointer;font:inherit}
	.sv-btn:hover{background:#d4e6d9}.sv-btn.on{background:#2f6b45;color:#fff}
	.sv-btn.dl{background:#2f6b45;color:#fff}.sv-btn.dl:hover{background:#245636}
	#sv-err{position:fixed;left:12px;right:12px;top:12px;background:#ffe3e3;color:#7a1010;border:2px solid #d33;border-radius:10px;padding:12px;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;display:none;z-index:9}
	@media (prefers-color-scheme: dark){html,body{background:#1f2a24}.sv-panel{background:rgba(24,32,27,.9);color:#e8f0ea}.sv-btn{background:#2c3a31;color:#e8f0ea}.sv-btn:hover{background:#38493e}}`;
	const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
	const wrap = document.createElement('div'); wrap.id = 'sv-wrap'; document.body.appendChild(wrap);
	const err = document.createElement('div'); err.id = 'sv-err'; document.body.appendChild(err);
	function fail(msg) { err.style.display = 'block'; err.textContent = msg; console.error(msg); }
	if (typeof THREE === 'undefined') return fail('three.js wurde nicht geladen (r128 von cdnjs). Die Umgebung blockiert vermutlich externe Scripts.');
	if (typeof StudKit === 'undefined') return fail('studkit.js wurde nicht geladen. Die Umgebung blockiert vermutlich externe Scripts.');
	if (typeof build !== 'function') return fail('Die Seite muss  function build(StudKit) { ...; return model; }  definieren.');

	let model;
	try { model = build(StudKit); } catch (e) { return fail('Fehler in build(): ' + (e && e.stack || e)); }
	if (model instanceof StudKit.Building) model = model.toGrid();
	const isCreature = model instanceof StudKit.Creature, isGrid = model instanceof StudKit.Grid;
	if (!isCreature && !isGrid) return fail('build() muss ein StudKit.Creature, StudKit.Grid oder StudKit.Building zurückgeben.');

	// ---------------------------------------------------------------- stud texture (one square stud per tile, 0.5 grey = neutral)
	function studCanvas(px, tiles, neutral) {
		const c = document.createElement('canvas'); c.width = c.height = px * tiles; const g = c.getContext('2d');
		const lv = v => { const x = Math.round(neutral * v / 128); return `rgb(${x},${x},${x})`; };
		g.fillStyle = lv(128); g.fillRect(0, 0, c.width, c.height);
		for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
			const o = [tx * px, ty * px], a = px * 0.25, b = px * 0.75, e = Math.max(1, px * 0.06);
			const R = (x0, y0, x1, y1, v) => { g.fillStyle = lv(v); g.fillRect(o[0] + x0, o[1] + y0, x1 - x0, y1 - y0); };
			R(a - e * 0.5, b, b + e * 0.5, b + e * 0.9, 100);                 // soft drop shadow under the stud
			R(a, a, b, b, 136);                                                // stud face
			R(a, a, b, a + e, 170);                                            // top edge (lit)
			R(b - e, a, b, b, 182);                                            // right edge (lit)
			R(a, a + e, a + e, b, 82);                                         // left edge (shade)
			R(a + e, b - e, b, b, 90);                                         // bottom edge (shade)
		}
		return c;
	}
	const studTex = new THREE.CanvasTexture(studCanvas(64, 1, 128));
	studTex.wrapS = studTex.wrapT = THREE.RepeatWrapping; studTex.anisotropy = 8;
	StudKit.studPNG = () => new Promise(res => studCanvas(64, 8, 255).toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/png'));

	// ---------------------------------------------------------------- renderer, scene, lights
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.outputEncoding = THREE.sRGBEncoding; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	wrap.appendChild(renderer.domElement);
	const scene = new THREE.Scene();
	const dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
	const bg = new THREE.Color(0xbfe3c6); scene.background = bg;   // the scene stays light like the reference sheets (UI follows dark mode)
	scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x5a6b4a, 0.75));
	const sun = new THREE.DirectionalLight(0xffffff, 1.05); sun.castShadow = true; scene.add(sun); scene.add(sun.target);
	const fill = new THREE.DirectionalLight(0xbcd0ff, 0.35); scene.add(fill);
	const back = new THREE.DirectionalLight(0xffffff, 0.3); scene.add(back);
	const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x6a975f, roughness: 1 }));
	ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

	// ---------------------------------------------------------------- materials
	function studMaterial() {
		const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: studTex, roughness: 0.62, metalness: 0 });
		m.onBeforeCompile = sh => {
			sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + NL + 'attribute float studOn; attribute vec2 studN; varying float vStudOn; varying vec2 vStudN; varying vec2 vStudUv;')
				.replace('#include <uv_vertex>', '#include <uv_vertex>' + NL + 'vStudOn = studOn; vStudN = studN; vStudUv = uv;');
			sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + NL + 'varying float vStudOn; varying vec2 vStudN; varying vec2 vStudUv;')
				.replace('#include <map_fragment>', [
					'float inS = step(-1e-4, vStudUv.x) * step(vStudUv.x - vStudN.x, 1e-4) * step(-1e-4, vStudUv.y) * step(vStudUv.y - vStudN.y, 1e-4);',
					'vec4 texelColor = texture2D(map, vStudUv);',
					'diffuseColor.rgb *= mix(vec3(1.0), texelColor.rgb * 2.0, vStudOn * inS);'].join(NL));
		};
		return m;
	}
	const solidMat = studMaterial();
	const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
	const meshes = [];
	function addMesh(parent, P, Nn, C, U, T, SN, I, glow) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
		g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
		g.setAttribute('studOn', new THREE.Float32BufferAttribute(T, 1));
		g.setAttribute('studN', new THREE.Float32BufferAttribute(SN, 2));
		g.setIndex(new THREE.BufferAttribute(I instanceof Uint32Array ? I : new Uint32Array(I), 1));
		const m = new THREE.Mesh(g, glow ? glowMat : solidMat); m.castShadow = !glow; m.receiveShadow = true; m.userData.glow = glow;
		parent.add(m); meshes.push(m); return m;
	}

	// ---------------------------------------------------------------- build the scene graph
	const modelRoot = new THREE.Group(); scene.add(modelRoot);
	const boneGroups = {};
	let restHeads = {};
	if (isCreature) buildCreature(); else buildGrid();

	function buildCreature() {
		const C = model, S = C.STUDS, toR = StudKit.toR;
		const heads = {};
		for (const [n, h, , p] of C.BONES) {
			const hr = toR(h).map(v => v * S); heads[n] = hr;
			const g = new THREE.Group(); g.name = n;
			const ph = p ? heads[p] : [0, 0, 0];
			g.position.set(hr[0] - ph[0], hr[1] - ph[1], hr[2] - ph[2]);
			(p ? boneGroups[p] : modelRoot).add(g); boneGroups[n] = g;
		}
		restHeads = heads;
		const acc = {};
		const get = (bone, glow) => { const k = bone + '|' + (glow ? 1 : 0); return acc[k] || (acc[k] = { P: [], N: [], C: [], U: [], T: [], SN: [], I: [] }); };
		const lin = StudKit.lin;
		C.boxes.forEach((b, bi) => {
			const glow = C.GLOW.has(b.k), plain = C.NOSTUD.has(b.k);
			const col = StudKit.rgb(C.PALETTE[b.k]).map(lin);
			const buf = get(b.bone, glow), hb = heads[b.bone];
			const e = 2e-4 + 6e-5 * (bi + 1);                                    // anti z-fight: later boxes a hair bigger
			const s = b.s.map(v => v + e);
			const R = b.R, aligned = Math.abs(R[0] - 1) < 1e-4 && Math.abs(R[4] - 1) < 1e-4 && Math.abs(R[8] - 1) < 1e-4;
			const world = l => { const w = [R[0] * l[0] + R[1] * l[1] + R[2] * l[2], R[3] * l[0] + R[4] * l[1] + R[5] * l[2], R[6] * l[0] + R[7] * l[1] + R[8] * l[2]]; return [b.c[0] + w[0], b.c[1] + w[1], b.c[2] + w[2]]; };
			const emit = (worldPts, n, uvs, sn, studOn) => {
				const cen = worldPts.reduce((q, p) => [q[0] + p[0] / worldPts.length, q[1] + p[1] / worldPts.length, q[2] + p[2] / worldPts.length], [0, 0, 0]);
				if ((cen[0] - b.c[0]) * n[0] + (cen[1] - b.c[1]) * n[1] + (cen[2] - b.c[2]) * n[2] < -1e-6) {   // keep every face pointing outwards
					worldPts = worldPts.slice().reverse(); uvs = uvs.slice().reverse(); n = n.map(v => -v);
				}
				const base = buf.P.length / 3, nr = toR(n);
				for (let i = 0; i < worldPts.length; i++) {
					const r = toR(worldPts[i]).map(v => v * S);
					buf.P.push(r[0] - hb[0], r[1] - hb[1], r[2] - hb[2]); buf.N.push(...nr); buf.C.push(...col);
					buf.U.push(...uvs[i]); buf.T.push(studOn); buf.SN.push(...sn);
				}
				for (let i = 1; i < worldPts.length - 1; i++) buf.I.push(base, base + i, base + i + 1);
			};
			if (b.shape === 'Box') {
				const L = b.s.map(v => v * S), nst = L.map(v => Math.floor(v + 0.35));
				for (let ax = 0; ax < 3; ax++) for (const sg of [1, -1]) {
					const a = (ax + 1) % 3, c2 = (ax + 2) % 3;
					const loc = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => { const l = [0, 0, 0]; l[ax] = sg * 0.5; l[a] = u; l[c2] = v; return l; });
					if (sg < 0) loc.reverse();
					const pts = loc.map(l => world([l[0] * s[0], l[1] * s[1], l[2] * s[2]]));
					const nl = [0, 0, 0]; nl[ax] = sg; const n = [R[0] * nl[0] + R[1] * nl[1] + R[2] * nl[2], R[3] * nl[0] + R[4] * nl[1] + R[5] * nl[2], R[6] * nl[0] + R[7] * nl[1] + R[8] * nl[2]];
					let uvs, sn;
					if (aligned) { uvs = pts.map(p => [p[a] * S + 1000, p[c2] * S + 1000]); sn = plain ? [0, 0] : [1e6, 1e6]; }
					else {
						const f = (lc, i) => (nst[i] > L[i] ? (lc + 0.5) * nst[i] : (lc + 0.5) * L[i] - (L[i] - nst[i]) / 2);
						uvs = loc.map(l => [f(l[a], a), f(l[c2], c2)]); sn = plain ? [0, 0] : [nst[a], nst[c2]];
					}
					emit(pts, n, uvs, sn, plain || glow ? 0 : 1);
				}
			} else if (b.shape === 'Wedge') {
				const V = [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5]].map(v => world([v[0] * s[0], v[1] * s[1], v[2] * s[2]]));
				for (const f of [[0, 3, 2, 1], [3, 4, 5, 2], [0, 1, 5, 4], [0, 4, 3], [1, 2, 5]]) {
					const pts = f.map(i => V[i]), n = normalOf(pts);
					emit(pts, n, pts.map(() => [0, 0]), [0, 0], 0);
				}
			} else {                                                             // cylinder, axis = local x
				const seg = 14, ring = (x, i) => world([x * s[0], 0.5 * s[1] * Math.cos(2 * Math.PI * i / seg), 0.5 * s[2] * Math.sin(2 * Math.PI * i / seg)]);
				for (let i = 0; i < seg; i++) { const pts = [ring(-0.5, i), ring(-0.5, i + 1), ring(0.5, i + 1), ring(0.5, i)]; emit(pts, normalOf(pts), pts.map(() => [0, 0]), [0, 0], 0); }
				for (const x of [-0.5, 0.5]) { const pts = []; for (let i = 0; i < seg; i++) pts.push(ring(x, x > 0 ? i : seg - i)); emit(pts, normalOf(pts), pts.map(() => [0, 0]), [0, 0], 0); }
			}
		});
		for (const k in acc) { const [bone, gl] = k.split('|'); const a = acc[k]; addMesh(boneGroups[bone], a.P, a.N, a.C, a.U, a.T, a.SN, a.I, gl === '1'); }
	}
	function normalOf(p) {                                   // Newell normal of a polygon (Blender coords)
		const n = [0, 0, 0];
		for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
		const l = Math.hypot(...n) || 1; return n.map(v => v / l);
	}
	function buildGrid() {
		const g = model, pieces = g.mesh(), S = g.studs;
		if (g.RIG) {
			for (const [n, p, h] of g.RIG) {
				const grp = new THREE.Group(); grp.name = n; const ph = p ? g.RIG.find(b => b[0] === p)[2] : [0, 0, 0];
				grp.position.set((h[0] - ph[0]) * S, (h[1] - ph[1]) * S, (h[2] - ph[2]) * S);
				(p ? boneGroups[p] : modelRoot).add(grp); boneGroups[n] = grp; restHeads[n] = h.map(v => v * S);
			}
		}
		for (const pc of pieces) {
			const parent = g.RIG ? boneGroups[g.RIG[pc.bone][0]] : modelRoot, hb = g.RIG ? restHeads[g.RIG[pc.bone][0]] : [0, 0, 0];
			const P = new Float32Array(pc.positions); for (let i = 0; i < P.length; i += 3) { P[i] -= hb[0]; P[i + 1] -= hb[1]; P[i + 2] -= hb[2]; }
			const SN = new Float32Array((P.length / 3) * 2).fill(1e6);
			addMesh(parent, P, pc.normals, pc.colors, pc.uvs, pc.studOn, SN, pc.indices, !!pc.glow);
		}
		for (const L of g.lights) { const pl = new THREE.PointLight(new THREE.Color(...L.colour), 1.4 * L.strength, 40 * S, 2); pl.position.set(L.pos[0] * S, L.pos[1] * S, L.pos[2] * S); modelRoot.add(pl); }
	}

	// ---------------------------------------------------------------- framing
	const box3 = new THREE.Box3().setFromObject(modelRoot);
	const size = box3.getSize(new THREE.Vector3()), center = box3.getCenter(new THREE.Vector3());
	if (isGrid) { modelRoot.position.y -= box3.min.y; center.y -= box3.min.y; box3.translate(new THREE.Vector3(0, -box3.min.y, 0)); }
	const radius = Math.max(size.x, size.y, size.z) * 0.62 + 1;
	scene.fog = new THREE.Fog(bg, radius * 7, radius * 16);
	const camera = new THREE.PerspectiveCamera(24, 1, radius * 0.05, radius * 60);
	const controls = new THREE.OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true; controls.target.copy(center);
	const sh = sun.shadow.camera; sh.left = sh.bottom = -radius * 1.6; sh.right = sh.top = radius * 1.6; sh.near = 0.1; sh.far = radius * 12; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
	function lights() {
		sun.position.set(center.x - radius * 2.2, center.y + radius * 4, center.z - radius * 3.2); sun.target.position.copy(center);
		fill.position.set(center.x + radius * 3, center.y + radius * 1.5, center.z - radius); back.position.set(center.x, center.y + radius * 2, center.z + radius * 4);
	}
	lights();
	const VIEWS = { Vorne: [0, 12], 'Schräg': [-40, 14], Seite: [-90, 10], Hinten: [160, 14], Oben: [-30, 60] };
	function view(name) {
		const [yaw, pitch] = VIEWS[name], y = yaw * Math.PI / 180, p = pitch * Math.PI / 180, dist = radius / Math.tan(12 * Math.PI / 180) * 0.9;
		camera.position.set(center.x - Math.sin(y) * Math.cos(p) * dist, center.y + Math.sin(p) * dist, center.z - Math.cos(y) * Math.cos(p) * dist);
		controls.target.copy(center); controls.update();
	}

	// ---------------------------------------------------------------- post: silhouette outline + glow
	const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat };
	// the model is drawn straight to the (antialiased) canvas; outline + glow are drawn on top as a blended overlay
	const rtMask = new THREE.WebGLRenderTarget(1, 1, rtOpts), rtGlow = new THREE.WebGLRenderTarget(1, 1, rtOpts), rtBlur = new THREE.WebGLRenderTarget(1, 1, rtOpts);
	const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quadScene.add(quad);
	const vs = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
	const blurMat = new THREE.ShaderMaterial({ uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2() } }, vertexShader: vs, fragmentShader: [
		'uniform sampler2D tex; uniform vec2 dir; varying vec2 vUv;',
		'void main(){ vec4 s = texture2D(tex, vUv) * 0.2;',
		' for (int i = 1; i < 8; i++) { float w = 0.2 * exp(-float(i * i) / 18.0); s += (texture2D(tex, vUv + dir * float(i)) + texture2D(tex, vUv - dir * float(i))) * w; }',
		' gl_FragColor = s; }'].join(NL) });
	const lineMat = new THREE.ShaderMaterial({ uniforms: { mask: { value: null }, px: { value: new THREE.Vector2() }, r: { value: 3 } }, vertexShader: vs, transparent: true, depthTest: false, depthWrite: false, fragmentShader: [
		'uniform sampler2D mask; uniform vec2 px; uniform float r; varying vec2 vUv;',
		'void main(){',
		' float m = texture2D(mask, vUv).r, mx = 0.0;',
		' for (int i = 0; i < 16; i++) { float a = float(i) * 0.3927; vec2 d = vec2(cos(a), sin(a)) * px;',
		'   mx = max(mx, texture2D(mask, vUv + d * r).r); mx = max(mx, texture2D(mask, vUv + d * r * 0.5).r); }',
		' gl_FragColor = vec4(0.02, 0.02, 0.03, clamp(mx - m, 0.0, 1.0)); }'].join(NL) });
	const glowAddMat = new THREE.ShaderMaterial({ uniforms: { glow: { value: null }, k: { value: 1.3 } }, vertexShader: vs, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
		fragmentShader: 'uniform sampler2D glow; uniform float k; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(glow, vUv).rgb * k, 1.0); }' });
	const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff }), blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
	let showOutline = true, showGlow = true;
	function resize() {
		const w = wrap.clientWidth || innerWidth, h = wrap.clientHeight || innerHeight, pr = renderer.getPixelRatio();
		renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
		rtMask.setSize(w * pr, h * pr); rtGlow.setSize(w * pr / 2, h * pr / 2); rtBlur.setSize(w * pr / 2, h * pr / 2);
		lineMat.uniforms.px.value.set(1 / (w * pr), 1 / (h * pr)); lineMat.uniforms.r.value = Math.max(2, Math.round(h * pr / 320));
	}
	window.addEventListener('resize', resize);
	function render() {
		const keep = scene.background; ground.visible = false; scene.background = new THREE.Color(0x000000);
		scene.overrideMaterial = whiteMat; renderer.setRenderTarget(rtMask); renderer.render(scene, camera); scene.overrideMaterial = null;
		if (showGlow) {
			for (const m of meshes) { m.userData.mat = m.material; if (!m.userData.glow) m.material = blackMat; }
			renderer.setRenderTarget(rtGlow); renderer.render(scene, camera);
			for (const m of meshes) m.material = m.userData.mat;
			quad.material = blurMat; const w = rtGlow.width, h = rtGlow.height;
			blurMat.uniforms.tex.value = rtGlow.texture; blurMat.uniforms.dir.value.set(1.6 / w, 0); renderer.setRenderTarget(rtBlur); renderer.render(quadScene, quadCam);
			blurMat.uniforms.tex.value = rtBlur.texture; blurMat.uniforms.dir.value.set(0, 1.6 / h); renderer.setRenderTarget(rtGlow); renderer.render(quadScene, quadCam);
		} else { renderer.setRenderTarget(rtGlow); renderer.setClearColor(0x000000); renderer.clear(); }
		ground.visible = showGround; scene.background = keep;
		renderer.setRenderTarget(null); renderer.render(scene, camera);
		renderer.autoClear = false;
		if (showOutline) { quad.material = lineMat; lineMat.uniforms.mask.value = rtMask.texture; renderer.render(quadScene, quadCam); }
		if (showGlow) { quad.material = glowAddMat; glowAddMat.uniforms.glow.value = rtGlow.texture; renderer.render(quadScene, quadCam); }
		renderer.autoClear = true;
	}

	// ---------------------------------------------------------------- animation
	let clip = null, playing = false, t0 = performance.now(), frameNow = 0;
	const tmpM = new THREE.Matrix4();
	function applyPose(p) {
		if (!isCreature) return;
		const rp = model.rigPose(p || {});
		for (const [n, , , par] of model.BONES) {
			const R = rp.rot[n], g = boneGroups[n];
			tmpM.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1); g.quaternion.setFromRotationMatrix(tmpM);
			if (!par) { const h = restHeads[n]; g.position.set(h[0] + rp.rootLoc[0], h[1] + rp.rootLoc[1], h[2] + rp.rootLoc[2]); }
		}
	}
	function setClip(name) { clip = name; playing = !!name; t0 = performance.now(); if (!name) applyPose({}); syncButtons(); }

	// ---------------------------------------------------------------- UI
	const info = document.createElement('div'); info.id = 'sv-info'; info.className = 'sv-panel'; document.body.appendChild(info);
	const st = isCreature ? model.stats() : model.stats();
	info.innerHTML = '<h1></h1><div class="sv-stats"></div>';
	info.querySelector('h1').textContent = isCreature ? model.NAME : model.id;
	const hStuds = isCreature ? ((model.bounds().hi[2] - Math.min(0, model.bounds().lo[2])) * model.STUDS) : size.y;
	info.querySelector('.sv-stats').textContent = isCreature
		? `${st.boxes} Kisten · ${st.bones} Knochen · ${st.clips.length} Clips · ca. ${hStuds.toFixed(1)} Studs hoch`
		: `${st.bricks.toLocaleString('de-DE')} Klötzchen · ${st.tris.toLocaleString('de-DE')} Dreiecke · ${st.colours} Farben · ca. ${size.y.toFixed(0)} Studs hoch`;
	const bar = document.createElement('div'); bar.id = 'sv-bar'; bar.className = 'sv-panel'; document.body.appendChild(bar);
	const group = label => { const g = document.createElement('div'); g.className = 'sv-group'; const l = document.createElement('span'); l.className = 'sv-label'; l.textContent = label; g.appendChild(l); bar.appendChild(g); return g; };
	const btn = (g, text, fn, cls) => { const b = document.createElement('button'); b.className = 'sv-btn' + (cls ? ' ' + cls : ''); b.textContent = text; b.onclick = fn; g.appendChild(b); return b; };
	const gv = group('Ansicht'); for (const n in VIEWS) btn(gv, n, () => view(n));
	const clipBtns = {};
	if (isCreature && Object.keys(model.CLIPS).length) {
		const gc = group('Clips');
		clipBtns[''] = btn(gc, 'Ruhe', () => setClip(null));
		for (const n of Object.keys(model.CLIPS)) clipBtns[n] = btn(gc, n, () => setClip(n));
	}
	let showGround = true;
	const go = group('Optik');
	const tOutline = btn(go, 'Umriss', () => { showOutline = !showOutline; syncButtons(); });
	const tGlow = btn(go, 'Leuchten', () => { showGlow = !showGlow; syncButtons(); });
	const tGround = btn(go, 'Boden', () => { showGround = !showGround; syncButtons(); });
	function syncButtons() {
		tOutline.classList.toggle('on', showOutline); tGlow.classList.toggle('on', showGlow); tGround.classList.toggle('on', showGround);
		for (const k in clipBtns) clipBtns[k].classList.toggle('on', (clip || '') === k);
	}
	function download(name, data, type) {
		const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
		const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
		setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
	}
	const gd = group('Download');
	const exportsApi = {};
	if (isCreature) {
		exportsApi.rbxmx = () => model.toRbxmx(); exportsApi.data = () => model.toDataLuau(); exportsApi.clips = () => model.toClipsLuau();
		btn(gd, 'Roblox .rbxmx', () => download(model.NAME + '.rbxmx', exportsApi.rbxmx(), 'application/xml'), 'dl');
		btn(gd, 'Data .luau', () => download(model.NAME + 'Data.luau', exportsApi.data(), 'text/plain'), 'dl');
		if (Object.keys(model.CLIPS).length) btn(gd, 'Clips .luau', () => download(model.NAME + 'Clips.luau', exportsApi.clips(), 'text/plain'), 'dl');
	} else {
		exportsApi.glb = async () => model.toGLB(await StudKit.studPNG());
		btn(gd, 'Roblox .glb', async () => download(model.id + '.glb', await exportsApi.glb(), 'model/gltf-binary'), 'dl');
	}
	btn(gd, 'Bild .png', () => { render(); renderer.domElement.toBlob(b => download((isCreature ? model.NAME : model.id) + '.png', b)); }, 'dl');
	window.__model = model; window.__exports = exportsApi; window.__view = view; window.__setClip = setClip;
	window.__frame = f => { if (clip) applyPose(model.poseAt(clip, f)); render(); };

	// ---------------------------------------------------------------- loop
	resize(); view('Schräg'); syncButtons();
	const PV = (isCreature && model.PREVIEW) || {};
	if (PV.loop && model.CLIPS && model.CLIPS[PV.loop]) setClip(PV.loop);
	function loop() {
		requestAnimationFrame(loop); controls.update();
		if (playing && clip) {
			const L = model.CLIPS[clip][0]; frameNow = ((performance.now() - t0) / 1000 * 30) % Math.max(1, L);
			applyPose(model.poseAt(clip, frameNow));
		}
		render();
	}
	loop();
})();
