# voxel-kit

Baukasten für Roblox-Modelle im Voxel-Sculpt-Stil (viele kleine Parts, Farbverläufe, Neon-Details).
Wird vom Claude-Skill **voxel-figuren** benutzt, damit er auch dort läuft, wo der Skill keine Zusatzdateien mitbekommt (Claude Design).

- `voxel_kit.js`: Figur bauen (`new VoxelKit.Figure(...)`, `head`, `hand`, `boot`, `strands`, `chunk`, `crack`, …) und exportieren als `.rbxmx` (Roblox Studio, nur Parts, keine Scripts) und `.glb`.
- `viewer.js`: 3D-Vorschau mit Neon-Leuchten und Download-Knöpfen. Erwartet `function buildFigure(VoxelKit)` auf der Seite.
- `beispiel.html`: fertige Seite (Laternen-Opa) zum Ausprobieren.

Einbinden (Version fest angeben):

```html
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.0.0/voxel_kit.js"></script>
<script>function buildFigure(VoxelKit) { /* ... */ }</script>
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.0.0/viewer.js"></script>
```

three.js r128 und die Bloom-Add-ons müssen vorher geladen sein, siehe `beispiel.html`.
