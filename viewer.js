/*
 * Voxel Figure Kit viewer: 3D preview (three.js r128 + bloom), shamble preview, and the download buttons
 * (.rbxmx for Roblox Studio, .glb, .json, image). Brings its own CSS and buttons.
 * Load after three.js, its add-ons and voxel_kit.js; the page must define `function buildFigure(VoxelKit)`.
 */
(function () {
	'use strict';
	const CSS = "\t:root { --bg: #1d2129; --panel: rgba(18, 21, 28, 0.86); --line: #3a4150; --text: #e8ebf2; --muted: #9aa3b5; --accent: #9be15d; }\n\thtml, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; overflow: hidden; }\n\t#view { position: fixed; inset: 0; }\n\t.panel { position: fixed; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }\n\t#top { left: 12px; top: 12px; max-width: calc(100% - 48px); }\n\t#top h1 { margin: 0 0 4px; font-size: 17px; }\n\t#stats { color: var(--muted); font-size: 12px; white-space: pre-line; }\n\t#bar { left: 12px; bottom: 12px; right: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n\tbutton, select { background: #2a303c; color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: 6px 10px; font: inherit; cursor: pointer; }\n\tbutton:hover { border-color: var(--accent); }\n\tbutton.on { background: #3a5a2a; border-color: var(--accent); }\n\t.sep { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }\n\t#msg { color: var(--muted); font-size: 12px; margin-left: auto; }";
	const MARKUP = "<div id=\"view\"></div>\n<div class=\"panel\" id=\"top\"><h1 id=\"title\">Voxel-Figur</h1><div id=\"stats\"></div></div>\n<div class=\"panel\" id=\"bar\">\n\t<button data-view=\"front\">Vorne</button><button data-view=\"side\">Seite</button><button data-view=\"three\">3/4</button>\n\t<button id=\"spin\">Drehen</button><button id=\"anim\">Bewegen</button><button id=\"night\">Nacht</button>\n\t<span class=\"sep\"></span>\n\t<label>Gr\u00f6\u00dfe <select id=\"scale\">\n\t\t<option value=\"1\">Original (~16 Studs)</option>\n\t\t<option value=\"0.5\">Halb (~8 Studs)</option>\n\t\t<option value=\"0.33\">Spielergr\u00f6\u00dfe (~5,3 Studs)</option>\n\t\t<option value=\"1.5\">Riese (~24 Studs)</option>\n\t</select></label>\n\t<span class=\"sep\"></span>\n\t<button id=\"dl-rbxmx\">\u2b07 .rbxmx (Roblox)</button><button id=\"dl-glb\">\u2b07 .glb</button><button id=\"dl-json\">\u2b07 .json</button><button id=\"dl-png\">\u2b07 Bild</button>\n\t<button id=\"copy-rbxmx\">rbxmx kopieren</button>\n\t<span id=\"msg\"></span>\n</div>";

	function fail(text) {
		const el = document.createElement('pre');
		el.style.cssText = 'position:fixed;inset:20px;color:#ffb4b4;background:#2a1416;padding:16px;border-radius:10px;white-space:pre-wrap;font:14px system-ui';
		el.textContent = text; document.body.appendChild(el);
	}

	function start() {
		if (typeof THREE === 'undefined') return fail('three.js wurde nicht geladen.');
		if (typeof VoxelKit === 'undefined') return fail('VoxelKit (voxel_kit.js) wurde nicht geladen.');
		if (typeof buildFigure !== 'function') return fail('Die Seite definiert keine Funktion buildFigure(VoxelKit).');
		const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
		const holder = document.createElement('div'); holder.innerHTML = MARKUP;
		while (holder.firstChild) document.body.appendChild(holder.firstChild);
		try { run(); } catch (e) { fail('Fehler beim Bauen der Figur:' + String.fromCharCode(10) + (e && e.stack || e)); }
	}

	function run() {
	const fig = buildFigure(VoxelKit);
	window.__fig = fig; // handy for testing
	const $ = id => document.getElementById(id);
	const msg = t => { $('msg').textContent = t; };
	$('title').textContent = fig.name;
	document.title = fig.name;
	const st = fig.stats();
	$('stats').textContent = `${st.voxels} Klötzchen · ${st.colors} Farben · ${st.neon} Neon\nHöhe ${st.height} Studs · Breite ${st.width} Studs · Teile: ${Object.keys(st.perPart).length}`;

	// ---- three.js scene ----
	const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.outputEncoding = THREE.sRGBEncoding;
	$('view').appendChild(renderer.domElement);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x1d2129);
	const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
	const controls = new THREE.OrbitControls(camera, renderer.domElement);
	controls.target.set(0, 8, 0); controls.enableDamping = true;
	const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 0.75); scene.add(hemi);
	const sun = new THREE.DirectionalLight(0xffffff, 0.95);
	sun.position.set(14, 30, -18); sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 22, bottom: -4, near: 1, far: 80 });
	scene.add(sun);
	const fill = new THREE.DirectionalLight(0x9fb6ff, 0.35); fill.position.set(-16, 10, 12); scene.add(fill);
	const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: new THREE.Color(0x23272f).convertSRGBToLinear(), roughness: 1 }));
	ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
	const grid = new THREE.GridHelper(24, 24, 0x566070, 0x454c5a); grid.position.y = 0.01; scene.add(grid);

	// ---- figure: one group per body part, nested like the skeleton so the preview can animate ----
	const groups = {};
	const parts = fig.parts;
	const used = new Set(fig.usedParts());
	const rootGroup = new THREE.Group(); scene.add(rootGroup);
	function groupOf(name) {
		if (groups[name]) return groups[name];
		const p = parts[name];
		const g = new THREE.Group(); g.name = name;
		const parent = p.parent && parts[p.parent] ? groupOf(p.parent) : null;
		const pj = parent ? parts[p.parent].joint : [0, 0, 0];
		g.position.set(p.joint[0] - pj[0], p.joint[1] - pj[1], p.joint[2] - pj[2]);
		(parent || rootGroup).add(g);
		return (groups[name] = g);
	}
	for (const n of used) groupOf(n);
	const boxGeo = new THREE.BoxGeometry(1, 1, 1);
	const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12); cylGeo.rotateZ(-Math.PI / 2); // axis along X like Roblox
	const mats = {};
	function matFor(v) {
		const key = v.c.join() + v.mat + v.t;
		if (mats[key]) return mats[key];
		const col = new THREE.Color().setRGB(v.c[0] / 255, v.c[1] / 255, v.c[2] / 255).convertSRGBToLinear();
		const m = new THREE.MeshStandardMaterial({ color: col, roughness: v.mat === 'Glass' ? 0.1 : 0.82, metalness: v.mat === 'Metal' ? 0.5 : 0 });
		if (v.mat === 'Neon') { m.emissive = col.clone(); m.emissiveIntensity = 2.2; }   // above 1 so the bloom picks it up
		if (v.t > 0) { m.transparent = true; m.opacity = 1 - v.t; m.depthWrite = false; }
		return (mats[key] = m);
	}
	for (const v of fig.voxels) {
		if (v.t >= 1) continue;
		const g = groups[v.part]; const j = parts[v.part].joint;
		const cyl = v.shape === 'Cylinder';
		const mesh = new THREE.Mesh(cyl ? cylGeo : boxGeo, matFor(v));
		const R = v.R, s = cyl ? [v.s[0], Math.min(v.s[1], v.s[2]), Math.min(v.s[1], v.s[2])] : v.s;
		mesh.matrixAutoUpdate = false;
		mesh.matrix.set(R[0] * s[0], R[1] * s[1], R[2] * s[2], v.p[0] - j[0],
			R[3] * s[0], R[4] * s[1], R[5] * s[2], v.p[1] - j[1],
			R[6] * s[0], R[7] * s[1], R[8] * s[2], v.p[2] - j[2],
			0, 0, 0, 1);
		mesh.castShadow = mesh.receiveShadow = v.mat !== 'Neon';
		g.add(mesh);
	}

	// ---- views ----
	const top = st.bottom + st.height;
	const views = {
		front: [[0, top * 0.55, -top * 2.3], [0, top * 0.5, 0]],
		side: [[top * 2.3, top * 0.55, 0], [0, top * 0.5, 0]],
		three: [[top * 1.45, top * 0.85, -top * 1.75], [0, top * 0.48, 0]],
	};
	function setView(k) { const [p, t] = views[k]; camera.position.set(...p); controls.target.set(...t); controls.update(); }
	document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
	setView('three');
	$('spin').onclick = () => { controls.autoRotate = !controls.autoRotate; $('spin').classList.toggle('on', controls.autoRotate); };
	let animating = false;
	$('anim').onclick = () => { animating = !animating; $('anim').classList.toggle('on', animating); if (!animating) resetPose(); };

	// ---- shamble preview (rotations about the joints; only for looking, nothing of this is exported) ----
	function resetPose() {
		for (const n in groups) groups[n].rotation.set(0, 0, 0);
		if (groups.Pelvis) groups.Pelvis.position.y = parts.Pelvis.joint[1];
		if (groups.Body && parts.Body.parent == null) groups.Body.position.y = parts.Body.joint[1];
	}
	const SKEL = new Set([...Object.keys(VoxelKit.SKELETON), ...Object.keys(VoxelKit.QUADRUPED)]);
	function pose(t) {
		const g = groups, sn = Math.sin;
		if (g.Pelvis) g.Pelvis.position.y = parts.Pelvis.joint[1] + 0.12 * Math.abs(sn(2 * t));
		if (g.Torso) { g.Torso.rotation.x = -0.16 + 0.04 * sn(2 * t); g.Torso.rotation.z = 0.05 * sn(t); }
		if (g.Head) { g.Head.rotation.z = 0.13 * sn(0.8 * t); g.Head.rotation.x = 0.08 + 0.05 * sn(1.3 * t); }
		if (g.Jaw) g.Jaw.rotation.x = -0.28 * (0.5 + 0.5 * sn(3 * t));
		for (const [side, ph] of [['R', 0], ['L', Math.PI]]) {
			if (g['Upper' + side]) g['Upper' + side].rotation.x = (fig.posed ? 0 : 1.15) + 0.12 * sn(2 * t + ph);
			if (g['Fore' + side]) g['Fore' + side].rotation.x = 0.15 + 0.1 * sn(2 * t + ph + 0.6);
			if (g['Thigh' + side]) g['Thigh' + side].rotation.x = 0.38 * sn(t * 2 + ph);
			if (g['Shin' + side]) g['Shin' + side].rotation.x = -0.45 * Math.max(0, sn(t * 2 + ph + 1.2));
		}
		// four-legged creatures: diagonal legs move together, tail wags, head bobs
		for (const [leg, ph] of [['FrontLegR', 0], ['BackLegL', 0], ['FrontLegL', Math.PI], ['BackLegR', Math.PI]]) if (g[leg]) g[leg].rotation.x = 0.45 * sn(3 * t + ph);
		if (g.Tail) g.Tail.rotation.y = 0.45 * sn(4 * t);
		if (g.Neck) g.Neck.rotation.x = 0.08 * sn(3 * t);
		if (g.Body && !g.Pelvis) g.Body.position.y = parts.Body.joint[1] + 0.08 * Math.abs(sn(3 * t));
		let k = 0;
		for (const n in g) if (!SKEL.has(n) && parts[n].sway !== false) g[n].rotation.z = 0.12 * sn(1.6 * t + (k++));
	}

	// ---- glow: Neon blooms like in Roblox (falls back to a plain render if the add-on scripts did not load) ----
	let composer = null, bloom = null;
	if (THREE.EffectComposer && THREE.UnrealBloomPass && THREE.GammaCorrectionShader) {
		composer = new THREE.EffectComposer(renderer);
		composer.addPass(new THREE.RenderPass(scene, camera));
		bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 1.0);   // threshold 1: only Neon (emissive > 1) blooms, not sunlit white cloth
		composer.addPass(bloom);
		composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));
	}
	// with the composer the gamma pass converts everything, so colours set as sRGB hex must be made linear first
	const bgDay = 0x1d2129, bgNight = 0x07080c;
	const setBg = hex => { scene.background.set(hex); if (composer) scene.background.convertSRGBToLinear(); };
	setBg(bgDay);
	let night = false;
	$('night').onclick = () => {
		night = !night; $('night').classList.toggle('on', night);
		hemi.intensity = night ? 0.22 : 0.75; sun.intensity = night ? 0.25 : 0.95; fill.intensity = night ? 0.12 : 0.35;
		setBg(night ? bgNight : bgDay);
		if (bloom) { bloom.strength = night ? 1.2 : 0.6; bloom.threshold = night ? 0.75 : 1.0; }
	};
	const draw = () => (composer ? composer.render() : renderer.render(scene, camera));
	function resize() {
		const w = window.innerWidth, h = window.innerHeight;
		renderer.setSize(w, h); if (composer) composer.setSize(w, h);
		camera.aspect = w / h; camera.updateProjectionMatrix();
	}
	window.addEventListener('resize', resize); resize();
	const clock = new THREE.Clock();
	(function loop() { requestAnimationFrame(loop); if (animating) pose(clock.getElapsedTime()); controls.update(); draw(); })();

	// ---- export ----
	const scale = () => parseFloat($('scale').value);
	const safe = fig.name.replace(/[^\w-]+/g, '_');
	window.__exports = { rbxmx: () => fig.toRbxmx({ scale: scale() }), glb: () => fig.toGLB({ scale: scale() }), json: () => JSON.stringify(fig.toJSON()) };
	function download(data, name, type) {
		try {
			const url = URL.createObjectURL(new Blob([data], { type }));
			const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 4000);
			msg('Gespeichert: ' + name);
		} catch (e) { msg('Download blockiert: ' + e.message + ' (rbxmx kopieren nutzen)'); }
	}
	$('dl-rbxmx').onclick = () => download(window.__exports.rbxmx(), safe + '.rbxmx', 'application/xml');
	$('dl-glb').onclick = () => download(window.__exports.glb(), safe + '.glb', 'model/gltf-binary');
	$('dl-json').onclick = () => download(window.__exports.json(), safe + '.json', 'application/json');
	$('dl-png').onclick = () => { draw(); renderer.domElement.toBlob(b => download(b, safe + '.png', 'image/png')); };
	$('copy-rbxmx').onclick = async () => {
		try { await navigator.clipboard.writeText(window.__exports.rbxmx()); msg('rbxmx kopiert: in eine Textdatei einfügen und als .rbxmx speichern'); }
		catch (e) { msg('Kopieren nicht erlaubt: ' + e.message); }
	};
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
