/**
 * PLATFORM FACTORY
 * =================
 *
 * Creates static Arcade Physics bodies from validated SceneV1 objects
 * where type === 'platform'.
 *
 * Each platform is a Zone with a static physics body (invisible collider)
 * plus a row of Lucide icon tiles for the visual.
 *
 * VISUAL LAYOUT:
 *   All tiles use a fixed size (BOX_SIZE_RATIO × worldH), so every box
 *   across every platform looks identical. The number of tiles is
 *   determined by how many fixed-size boxes fit the platform width,
 *   with a minimum of MIN_TILES to ensure jumpability. Wider platforms
 *   from the scene data will produce more tiles.
 *
 * OVERLAP REMOVAL:
 *   After computing platform bounds, any platform that overlaps a
 *   previously placed platform is skipped (first-come wins).
 *
 *   Each surface type maps to a different Lucide icon via game_icons.ts:
 *     solid     → SquareSquare     (green)
 *     soft      → SquareArrowDown  (purple)
 *     bouncy    → SquareActivity   (yellow)
 *     slippery  → SquareCode       (blue)
 *     breakable → SquareX          (red)
 *
 *   Tiles are stored on the zone via zone.setData('tiles', [...]).
 *
 * Minimum dimensions come from ComputedPhysics (world-relative).
 */

import type { SceneObject } from '../../shared/schema/scene_v1.types';
import { normRectToWorldRect } from '../utils/coords';
import type { ComputedPhysics } from '../physics/PhysicsConfig';
import type { GameIconKey } from '../assets/game_icons';
import { ensureIconTexture, getIconTextureKey } from '../assets/IconTextureFactory';

/** Fixed box size as a fraction of world height (square tiles). */
const BOX_SIZE_RATIO = 0.05;

/** Minimum number of tiles per platform. */
const MIN_TILES = 5;

/** Map surface type string → GameIconKey for platform icons */
const SURFACE_ICON: Record<string, GameIconKey> = {
    solid:     'platform_solid',
    bouncy:    'platform_bouncy',
    slippery:  'platform_slippery',
    breakable: 'platform_breakable',
    soft:      'platform_soft',
};

const DEFAULT_ICON: GameIconKey = 'platform_solid';

/** Texture size for platform tile icons (px). Scaled to actual tile dimensions. */
const ICON_RENDER_SIZE = 64;

/** Simple AABB check — returns true if rects overlap or are too close */
interface Rect { x: number; y: number; w: number; h: number }

function rectsTooClose(a: Rect, b: Rect, minGap: number): boolean {
    // Expand rect `b` by minGap on all sides, then check overlap
    return (
        a.x < b.x + b.w + minGap &&
        a.x + a.w > b.x - minGap &&
        a.y < b.y + b.h + minGap &&
        a.y + a.h > b.y - minGap
    );
}

export function createPlatforms(
    scene: Phaser.Scene,
    objects: SceneObject[],
    worldW: number,
    worldH: number,
    phys: ComputedPhysics,
): Phaser.Physics.Arcade.StaticGroup {
    const group = scene.physics.add.staticGroup();

    const platforms = objects.filter(o => o.type === 'platform');

    // Fixed tile size in pixels (same for every platform)
    const boxSize = Math.round(worldH * BOX_SIZE_RATIO);
    const minPlatformW = MIN_TILES * boxSize;

    // Minimum gap between platforms = 2× player width
    const minGap = phys.playerSizePx * 2;

    // Max reachable height from the floor (bottom of world)
    // Platform top must be within this distance of worldH
    const maxReachFromFloor = phys.maxJumpHeight * 0.85; // 85% of max jump for safety margin

    // Track placed platform bounds for overlap / proximity detection
    const placedRects: Rect[] = [];

    for (const obj of platforms) {
        const rect = normRectToWorldRect(obj.bounds_normalized, worldW, worldH);

        // Skip tiny platforms that would be unplayable
        if (rect.w < phys.minPlatformWidth || rect.h < phys.minPlatformHeight) {
            continue;
        }

        // Use the larger of scene data width or minimum width
        const effectiveW = Math.max(rect.w, minPlatformW);

        // How many fixed-size boxes fit (always at least MIN_TILES)
        const tileCount = Math.max(MIN_TILES, Math.round(effectiveW / boxSize));
        const platformW = tileCount * boxSize;

        // Center on the original rect center
        const cx = rect.x + rect.w / 2;
        let cy = rect.y + rect.h / 2;

        // --- Reachability: ensure the lowest platform is jumpable from the floor ---
        // The platform top edge (cy - boxSize/2) must be reachable from worldH.
        const platformTop = cy - boxSize / 2;
        const maxReachableY = worldH - maxReachFromFloor;
        if (platformTop < maxReachableY) {
            // Check if there's a lower platform already placed that could serve as a stepping stone
            const hasLowerPlatform = placedRects.some(
                p => p.y + p.h > cy && p.y + p.h <= worldH
            );
            if (!hasLowerPlatform) {
                // No stepping stone — lower this platform so it's reachable from the floor
                const newTop = maxReachableY;
                cy = newTop + boxSize / 2;
                console.info(`[PlatformFactory] Lowered platform ${obj.id} to be reachable from floor`);
            }
        }

        const leftEdge = cx - platformW / 2;

        // Build the platform's bounding rect for overlap check
        const platformRect: Rect = {
            x: leftEdge,
            y: cy - boxSize / 2,
            w: platformW,
            h: boxSize,
        };

        // Skip if this platform overlaps or is too close to any already-placed platform
        if (placedRects.some(placed => rectsTooClose(platformRect, placed, minGap))) {
            console.info(`[PlatformFactory] Skipping overlapping platform: ${obj.id}`);
            continue;
        }

        placedRects.push(platformRect);

        const surfaceType = obj.surface_type ?? 'solid';

        // Resolve the Lucide icon for this surface type
        const iconKey = SURFACE_ICON[surfaceType] ?? DEFAULT_ICON;
        ensureIconTexture(scene, iconKey, ICON_RENDER_SIZE);
        const textureKey = getIconTextureKey(iconKey, ICON_RENDER_SIZE);

        // --- Visual: row of fixed-size tiles ---
        const tiles: Phaser.GameObjects.Image[] = [];

        for (let i = 0; i < tileCount; i++) {
            const boxCx = leftEdge + boxSize * i + boxSize / 2;
            const tile = scene.add.image(boxCx, cy, textureKey)
                .setDisplaySize(boxSize, boxSize)
                .setAlpha(0.7);
            tiles.push(tile);
        }

        // --- Physics: zone matches the visual tile row ---
        const zone = scene.add.zone(cx, cy, platformW, boxSize);
        scene.physics.add.existing(zone, true); // true = static body

        // Store surface type so GameScene can read it during collisions
        zone.setData('surfaceType', surfaceType);

        // Store tiles for future sprite swaps
        zone.setData('tiles', tiles);

        group.add(zone);
    }

    console.info(`[PlatformFactory] Created ${group.getLength()} platforms from ${platforms.length} candidates`);

    return group;
}
