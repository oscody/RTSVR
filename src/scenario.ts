import {
  AssetManager,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PanelUI,
  RayInteractable,
  RingGeometry,
  Vector3,
  World,
} from "@iwsdk/core";
import {
  Combat,
  EnemyObjective,
  FactoryState,
  GameState,
  Health,
  PlayerBase,
  Presentation,
  ResourceNode,
  runtime,
  Selectable,
  selectEntity,
  TankState,
  WorkerState,
} from "./game-state.js";

const BOARD_Y = 0.72;

function modelRoot(
  world: World,
  parent: ReturnType<World["createTransformEntity"]>,
  key: string,
  name: string,
  position: Vector3,
  scale: number,
): { entity: ReturnType<World["createTransformEntity"]>; model: Object3D } {
  const root = new Group();
  root.name = name;
  root.position.copy(position);
  const gltf = AssetManager.getGLTF(key);
  if (!gltf) throw new Error(`Missing preloaded GLB: ${key}`);
  const model = gltf.scene;
  model.name = `${name}_Model`;
  model.scale.setScalar(scale);
  // Attach the model directly to the root Group, not as a separate transform
  // entity — the XR ray raycast only sees meshes within the interactable
  // entity's own Object3D subtree, so a child entity is invisible to it.
  root.add(model);
  const entity = world.createTransformEntity(root, parent);
  return { entity, model };
}

function addSelectionRing(
  world: World,
  entity: ReturnType<World["createTransformEntity"]>,
  radius: number,
): Mesh {
  const ring = new Mesh(
    new RingGeometry(radius * 0.78, radius, 32),
    new MeshBasicMaterial({
      color: 0x66e8ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  ring.name = `${entity.object3D?.name ?? "Object"}_Selection`;
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  ring.visible = false;
  world.createTransformEntity(ring, entity);
  return ring;
}

function addHealthBar(
  world: World,
  entity: ReturnType<World["createTransformEntity"]>,
  y: number,
): Mesh {
  const background = new Mesh(
    new BoxGeometry(0.58, 0.055, 0.025),
    new MeshBasicMaterial({ color: 0x171b26 }),
  );
  background.position.set(0, y, 0);
  world.createTransformEntity(background, entity);
  const fill = new Mesh(
    new BoxGeometry(0.54, 0.035, 0.032),
    new MeshBasicMaterial({ color: 0x60e58b }),
  );
  fill.position.set(0, y, 0.018);
  world.createTransformEntity(fill, entity);
  return fill;
}

function addProgressBar(
  world: World,
  entity: ReturnType<World["createTransformEntity"]>,
): Mesh {
  const background = new Mesh(
    new BoxGeometry(0.75, 0.06, 0.025),
    new MeshBasicMaterial({ color: 0x171b26 }),
  );
  background.position.set(0, 0.82, 0);
  world.createTransformEntity(background, entity);
  const fill = new Mesh(
    new BoxGeometry(0.7, 0.04, 0.032),
    new MeshBasicMaterial({ color: 0xffc857 }),
  );
  fill.position.set(0, 0.82, 0.018);
  fill.scale.x = 0.001;
  world.createTransformEntity(fill, entity);
  return fill;
}

function makeSelectable(
  world: World,
  entity: ReturnType<World["createTransformEntity"]>,
  kind: string,
  radius: number,
  healthFill?: Mesh,
  progressFill?: Mesh,
): void {
  entity
    .addComponent(RayInteractable)
    .addComponent(Selectable, { kind })
    .addComponent(Presentation, {
      selectionRing: addSelectionRing(world, entity, radius),
      healthFill,
      progressFill,
    });
}

// The static board (CommandTable + BoardTile_* terrain grid) is authored in
// Meta Spatial Editor (metaspatial/) and loaded via the GLXF level in index.ts.
export function createScenario(world: World): void {
  const rootObject = new Group();
  rootObject.name = "RTS_Tabletop";
  rootObject.position.set(0, BOARD_Y, -2.15);
  const root = world.createTransformEntity(rootObject);

  const stateObject = new Object3D();
  stateObject.name = "RTSGameState";
  world.createTransformEntity(stateObject, root).addComponent(GameState);

  const orderMarker = new Mesh(
    new RingGeometry(0.28, 0.36, 32),
    new MeshBasicMaterial({
      color: 0xffbd59,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    }),
  );
  orderMarker.name = "RTS_OrderMarker";
  orderMarker.rotation.x = -Math.PI / 2;
  orderMarker.position.y = 0.018;
  orderMarker.visible = false;
  world.createTransformEntity(orderMarker, root);

  const base = modelRoot(
    world,
    root,
    "hangarLargeA",
    "CommandCenter",
    new Vector3(-1.65, 0.06, 0.45),
    0.42,
  );
  const baseHealth = addHealthBar(world, base.entity, 1.05);
  base.entity.addComponent(PlayerBase).addComponent(Health, { current: 100, maximum: 100 });
  makeSelectable(world, base.entity, "base", 0.58, baseHealth);

  const worker = modelRoot(
    world,
    root,
    "rover",
    "MiningRover",
    new Vector3(-0.85, 0.08, 0.36),
    1.1,
  );
  worker.entity.addComponent(WorkerState, { stage: "idle", timer: 0, cargo: 0 });
  makeSelectable(world, worker.entity, "worker", 0.36);
  const cargo = AssetManager.getGLTF("rockCrystals")!.scene;
  cargo.scale.setScalar(0.22);
  cargo.position.set(0, 0.45, 0);
  cargo.visible = false;
  world.createTransformEntity(cargo, worker.entity);

  const resource = modelRoot(
    world,
    root,
    "rockCrystalsLargeA",
    "CrystalDeposit",
    new Vector3(1.48, 0.05, 0.48),
    0.4,
  );
  resource.entity.addComponent(ResourceNode, { remaining: 999 });
  makeSelectable(world, resource.entity, "resource", 0.45);

  const factory = modelRoot(
    world,
    root,
    "hangarSmallA",
    "FactoryPad",
    new Vector3(-0.28, 0.04, -0.58),
    0.12,
  );
  const factoryProgress = addProgressBar(world, factory.entity);
  factory.entity.addComponent(FactoryState, {
    built: false,
    building: false,
    buildProgress: 0,
    producing: false,
    productionProgress: 0,
  });
  makeSelectable(world, factory.entity, "factory", 0.52, undefined, factoryProgress);

  const tankRoot = new Group();
  tankRoot.name = "PlayerTank";
  tankRoot.position.set(0.42, 0.07, -0.48);
  tankRoot.visible = false;
  const tank = world.createTransformEntity(tankRoot, root);
  const tankBody = AssetManager.getGLTF("craftCargoB")!.scene;
  tankBody.scale.setScalar(0.26);
  world.createTransformEntity(tankBody, tank);
  const tankTurret = AssetManager.getGLTF("craftMiner")!.scene;
  tankTurret.scale.setScalar(0.17);
  tankTurret.position.set(0, 0.24, 0);
  tankTurret.rotation.y = Math.PI;
  world.createTransformEntity(tankTurret, tank);
  const tankHealth = addHealthBar(world, tank, 0.72);
  tank
    .addComponent(TankState, { ready: false })
    .addComponent(Health, { current: 100, maximum: 100 })
    .addComponent(Combat, { target: null, cooldown: 0 });
  makeSelectable(world, tank, "tank", 0.43, tankHealth);

  const enemy = modelRoot(
    world,
    root,
    "turretSingle",
    "EnemyTurret",
    new Vector3(1.56, 0.08, -0.56),
    0.65,
  );
  const enemyHealth = addHealthBar(world, enemy.entity, 0.84);
  enemy.entity.addComponent(EnemyObjective).addComponent(Health, { current: 100, maximum: 100 });
  makeSelectable(world, enemy.entity, "enemy", 0.45, enemyHealth);

  runtime.base = base.entity;
  runtime.worker = worker.entity;
  runtime.resourceNode = resource.entity;
  runtime.factory = factory.entity;
  runtime.tank = tank;
  runtime.enemy = enemy.entity;
  runtime.factoryModel = factory.model;
  runtime.workerCargoVisual = cargo;
  runtime.orderMarker = orderMarker;
  selectEntity(worker.entity);
}

export function createPanels(world: World): void {
  const command = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "/ui/command-panel.json",
      maxWidth: 1.25,
      maxHeight: 1.35,
    })
    .addComponent(RayInteractable);
  command.object3D!.name = "RTS_CommandPanel";
  command.object3D!.position.set(-2.8, 1.38, -2.05);
  command.object3D!.rotation.y = 0.32;

  const result = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "/ui/match-result.json",
      maxWidth: 1.45,
      maxHeight: 0.8,
    })
    .addComponent(RayInteractable);
  result.object3D!.name = "RTS_ResultPanel";
  result.object3D!.position.set(0, 2.05, -2.55);
  result.object3D!.visible = false;
}

export function addSceneLighting(world: World): void {
  world.scene.background = new Color(0x07101f);
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(-2, 5, 3);
  key.name = "RTS_KeyLight";
  world.createTransformEntity(key);
  const fill = new DirectionalLight(0x79a8ff, 1.2);
  fill.position.set(4, 3, 1);
  fill.name = "RTS_FillLight";
  world.createTransformEntity(fill);
}
