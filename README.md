# voxel-kit

Baukasten für Roblox-Modelle im Voxel-Sculpt-Stil (viele kleine Parts, Farbverläufe, Neon-Details).
Wird vom Claude-Skill **voxel-figuren** benutzt, damit er auch dort läuft, wo der Skill keine Zusatzdateien mitbekommt (Claude Design).

- `voxel_kit.js`: Figur bauen (`new VoxelKit.Figure(...)`, `body`, `head`, `hairCombed`, `hand`, `boot`, `collar`, `band`, `strands`, `crack`, `posePreset`, …) und exportieren als `.rbxmx` (Roblox Studio, nur Parts, keine Scripts) und `.glb`.
- `viewer.js`: 3D-Vorschau mit Neon-Leuchten und Download-Knöpfen. Erwartet `function buildFigure(VoxelKit)` auf der Seite.
- `beispiel.html`: fertige Seite (Laternen-Opa) zum Ausprobieren.

Einbinden (Version fest angeben):

```html
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.1.0/voxel_kit.js"></script>
<script>function buildFigure(VoxelKit) { /* ... */ }</script>
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.1.0/viewer.js"></script>
```

three.js r128 und die Bloom-Add-ons müssen vorher geladen sein, siehe `beispiel.html`.

## stud/ (seit v2.2.0)

Zweiter Baukasten für Modelle im Noppen-Stil (eckige Roblox-Studs als Textur, eine schwarze Silhouetten-Linie, Leuchten nur an Augen und Kernen):

- `stud/studkit.js`: `StudKit.Creature` (Tiere und Pets aus Kisten an Knochen, Animations-Clips, Export `.rbxmx` mit Motor6D und Animator-Modul, `Data/Clips.luau`), `StudKit.Grid` (Bosse aus geformten Klötzchen-Gittern, Plattenfugen, Palette, optionales Skelett, Export `.glb` bis 20k Dreiecke pro Teil), `StudKit.Building` (Gebäude in Einheiten mit Stein-, Brett-, Schindel- und Balkenmuster, feine Details).
- `stud/studviewer.js`: Vorschau mit Noppen-Shader, Umriss, Leuchten, Ansichten, Clips und Download-Knöpfen. Erwartet `function build(StudKit) { ...; return model; }` auf der Seite.

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.2.0/stud/studkit.js"></script>
<script>function build(StudKit) { /* ... */ }</script>
<script src="https://cdn.jsdelivr.net/gh/Skill1011/voxel-kit@v2.2.0/stud/studviewer.js"></script>
```
