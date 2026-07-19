import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

const container = document.getElementById("scene-container");

if (!container) {
  throw new Error("Missing #scene-container element.");
}

document.title = "Hello VR";

const pageStyles = document.createElement("style");
pageStyles.textContent = `
  html,
  body,
  #scene-container {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #081018;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .hud {
    position: fixed;
    left: 16px;
    top: 16px;
    z-index: 10;
    max-width: min(360px, calc(100vw - 32px));
    color: #f4f8fb;
    text-shadow: 0 1px 3px rgb(0 0 0 / 0.55);
  }

  .hud h1 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .hud p {
    margin: 0;
    color: #b9c8d4;
    font-size: 14px;
    line-height: 1.4;
  }
`;
document.head.append(pageStyles);

const hud = document.createElement("div");
hud.className = "hud";
hud.innerHTML = `
  <h1>Hello VR</h1>
  <p>Open this page in a WebXR-capable browser or headset, then enter VR.</p>
`;
document.body.append(hud);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x081018);
scene.fog = new THREE.Fog(0x081018, 8, 28);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  100,
);
camera.position.set(0, 1.6, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.append(renderer.domElement);
document.body.append(VRButton.createButton(renderer));

const room = new THREE.Group();
scene.add(room);

const hemiLight = new THREE.HemisphereLight(0xb8d7ff, 0x0f1a20, 1.3);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(4, 7, 3);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshStandardMaterial({
    color: 0x1f2a2e,
    roughness: 0.82,
    metalness: 0.04,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
room.add(floor);

const grid = new THREE.GridHelper(16, 32, 0x5ce1e6, 0x263a40);
grid.position.y = 0.01;
room.add(grid);

function createTextTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 384;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create text canvas.");
  }

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#f8fbff");
  gradient.addColorStop(1, "#8de6ff");

  context.fillStyle = "#10202a";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#66d9ef";
  context.lineWidth = 10;
  context.strokeRect(16, 16, canvas.width - 32, canvas.height - 32);
  context.fillStyle = gradient;
  context.font = "bold 112px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2 - 10);
  context.font = "36px system-ui, sans-serif";
  context.fillStyle = "#b9c8d4";
  context.fillText("Your first WebXR scene is running", canvas.width / 2, canvas.height / 2 + 90);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

const sign = new THREE.Mesh(
  new THREE.PlaneGeometry(2.8, 1.05),
  new THREE.MeshStandardMaterial({
    map: createTextTexture("Hello VR"),
    emissive: 0x16323d,
    emissiveIntensity: 0.75,
    roughness: 0.55,
  }),
);
sign.position.set(0, 1.75, -2.2);
room.add(sign);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.55, 0.55, 0.55),
  new THREE.MeshStandardMaterial({
    color: 0xffd166,
    roughness: 0.42,
    metalness: 0.12,
  }),
);
cube.position.set(0, 0.85, -1.2);
cube.castShadow = true;
cube.receiveShadow = true;
room.add(cube);

const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(0.24, 32, 16),
  new THREE.MeshStandardMaterial({
    color: 0x4ecdc4,
    emissive: 0x073b3a,
    emissiveIntensity: 0.3,
    roughness: 0.35,
  }),
);
sphere.position.set(-0.95, 1.25, -1.65);
sphere.castShadow = true;
room.add(sphere);

const torus = new THREE.Mesh(
  new THREE.TorusGeometry(0.32, 0.045, 16, 64),
  new THREE.MeshStandardMaterial({
    color: 0xf45b69,
    roughness: 0.48,
    metalness: 0.08,
  }),
);
torus.position.set(0.95, 1.22, -1.65);
torus.castShadow = true;
room.add(torus);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.08, 0.105, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
);
reticle.position.set(0, 1.35, -1.7);
room.add(reticle);

function buildController(index: number): THREE.Group {
  const controller = renderer.xr.getController(index);
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: index === 0 ? 0x8de6ff : 0xffd166 }),
  );
  ray.name = "ray";
  ray.scale.z = 4;
  controller.add(ray);
  scene.add(controller);
  return controller;
}

buildController(0);
buildController(1);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();

  cube.rotation.x = elapsed * 0.55;
  cube.rotation.y = elapsed * 0.8;
  sphere.position.y = 1.25 + Math.sin(elapsed * 1.7) * 0.08;
  torus.rotation.x = elapsed * 0.45;
  torus.rotation.y = elapsed * 0.9;
  reticle.rotation.z = elapsed;

  renderer.render(scene, camera);
});
