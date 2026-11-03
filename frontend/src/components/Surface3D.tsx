import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { lut, type Cmap } from "../colormap";
import type { Field } from "../types";

export function Surface3D({
  field,
  cmap,
  exag,
  lo,
  hi,
  onPick,
  onCursor,
}: {
  field: Field;
  cmap: Cmap;
  exag: number;
  lo: number;
  hi: number;
  onPick?: (x: number, y: number) => void;
  onCursor?: (x: number, y: number, z: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const props = useRef({ field, cmap, exag, lo, hi, onPick, onCursor });
  props.current = { field, cmap, exag, lo, hi, onPick, onCursor };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const host = el;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-inset").trim() || "#0a0e13";
    scene.background = new THREE.Color(bg);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.4, 1, 0.6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aadd, 0.35);
    fill.position.set(-1, 0.4, -0.4);
    scene.add(fill);
    let mesh: THREE.Mesh | null = null;
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function build() {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      const f = props.current.field;
      const stride = Math.max(1, Math.ceil(Math.max(f.w, f.h) / 380));
      const cols = Math.ceil(f.w / stride);
      const rows = Math.ceil(f.h / stride);
      const geo = new THREE.PlaneGeometry(f.fullW * f.fullMmpp, f.fullH * f.fullMmpp, cols - 1, rows - 1);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      const table = lut(props.current.cmap);
      const span = Math.max(props.current.hi - props.current.lo, 1e-9);
      const z0 = props.current.lo;
      const ex = props.current.exag;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const si = Math.min(f.w - 1, i * stride);
          const sj = Math.min(f.h - 1, j * stride);
          const z = f.z[sj * f.w + si];
          const idx = j * cols + i;
          pos.setZ(idx, (z || 0) * 1e-3 * ex);
          const t = Math.min(1, Math.max(0, ((z || 0) - z0) / span));
          const k = (t * 255) | 0;
          colors[idx * 3] = table[k * 3] / 255;
          colors[idx * 3 + 1] = table[k * 3 + 1] / 255;
          colors[idx * 3 + 2] = table[k * 3 + 2] / 255;
        }
      }
      pos.needsUpdate = true;
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide });
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      scene.add(mesh);
      const fov = Math.max(f.fullW, f.fullH) * f.fullMmpp;
      camera.position.set(fov * 0.15, Math.max(fov * 0.7, 1), fov * 0.9);
      controls.target.set(0, 0, 0);
      controls.update();
    }

    function resize() {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function hit(ev: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(pointer, camera);
      if (!mesh) return null;
      const hits = ray.intersectObject(mesh);
      if (!hits.length) return null;
      const p = hits[0].point;
      // Mesh is rotated -90° about X, and centred. Local plane was XY, world Y is height.
      const f = props.current.field;
      const x = p.x + (f.fullW * f.fullMmpp) / 2;
      const y = p.z + (f.fullH * f.fullMmpp) / 2;
      const zUm = p.y / props.current.exag * 1e3;
      return { x, y, z: zUm };
    }

    const onMove = (ev: PointerEvent) => {
      const p = hit(ev);
      if (p) props.current.onCursor?.(p.x, p.y, p.z);
    };
    const onClick = (ev: PointerEvent) => {
      const p = hit(ev);
      if (p) props.current.onPick?.(p.x, p.y);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    build();
    resize();
    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // Rebuild when the height field, colour, or exaggeration changes.
  }, [field, cmap, exag, lo, hi]);

  return <div ref={wrap} className="stage" />;
}
