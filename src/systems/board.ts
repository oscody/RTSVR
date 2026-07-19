import {
  AssetManager,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RayInteractable,
  Types,
  createComponent,
  createSystem,
} from "@iwsdk/core";

export const GRID_SIZE = 24;
export const TILE_SIZE = 0.18;
export const BOARD_Y = 0.78;

export function gridToWorld(x: number, y: number): [number, number] {
  const offset = (GRID_SIZE * TILE_SIZE) / 2 - TILE_SIZE / 2;
  return [x * TILE_SIZE - offset, y * TILE_SIZE - offset];
}

export const BoardTile = createComponent("BoardTile", {
  x: { type: Types.Int16, default: 0 },
  y: { type: Types.Int16, default: 0 },
});

function makeMarker(): Mesh {
  const marker = new Mesh(
    new PlaneGeometry(TILE_SIZE * 1.08, TILE_SIZE * 1.08),
    new MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  );
  marker.rotateX(-Math.PI / 2);
  marker.position.y = 0.023;
  marker.visible = false;
  return marker;
}

export class BoardSystem extends createSystem({
  hoveredTiles: { required: [BoardTile, Hovered] },
}) {
  private hoverMarker!: Mesh;

  init(): void {
    this.world.scene.background = new Color(0xb8d8f1);

    const rootObject = new Group();
    rootObject.name = "BoardRoot";
    rootObject.position.set(0, BOARD_Y, 0);
    const root = this.world.createTransformEntity(rootObject);

    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(2.5, 4, 3);
    sun.name = "BoardSun";
    this.world.createTransformEntity(sun, { parent: root });

    const table = new Mesh(
      new BoxGeometry(
        GRID_SIZE * TILE_SIZE + 0.45,
        0.12,
        GRID_SIZE * TILE_SIZE + 0.45,
      ),
      new MeshStandardMaterial({
        color: 0x5a4a36,
        roughness: 0.8,
        metalness: 0.05,
      }),
    );
    table.name = "BoardTable";
    table.position.y = -0.08;
    this.world.createTransformEntity(table, { parent: root });

    // The terrain.glb tile is a zero-thickness plane; give each tile a thin
    // invisible box so the ray BVH has a volume to hit.
    const proxyGeometry = new BoxGeometry(1, 0.06, 1);
    const proxyMaterial = new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
    });
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const gltf = AssetManager.getGLTF("terrain");
        if (!gltf) throw new Error("terrain.glb not preloaded");
        const tile = gltf.scene;
        tile.name = `Tile_${x}_${y}`;
        const [worldX, worldZ] = gridToWorld(x, y);
        tile.position.set(worldX, 0, worldZ);
        tile.scale.setScalar(TILE_SIZE * 0.96);
        const proxy = new Mesh(proxyGeometry, proxyMaterial);
        proxy.position.y = 0.03;
        tile.add(proxy);
        this.world
          .createTransformEntity(tile, { parent: root })
          .addComponent(BoardTile, { x, y })
          .addComponent(RayInteractable);
      }
    }

    this.hoverMarker = makeMarker();
    this.world.createTransformEntity(this.hoverMarker, { parent: root });

    this.cleanupFuncs.push(
      this.queries.hoveredTiles.subscribe("qualify", (entity) => {
        const [worldX, worldZ] = gridToWorld(
          entity.getValue(BoardTile, "x") ?? 0,
          entity.getValue(BoardTile, "y") ?? 0,
        );
        this.hoverMarker.position.set(worldX, 0.023, worldZ);
        this.hoverMarker.visible = true;
      }),
      this.queries.hoveredTiles.subscribe("disqualify", () => {
        if (this.queries.hoveredTiles.entities.size === 0) {
          this.hoverMarker.visible = false;
        }
      }),
    );
  }
}
