/**
 * Seat / cluster layout constants for the office tile background.
 *
 * Coordinates are normalized fractions of the source tile dimensions
 * (X / TILE_W, Y / TILE_H) so they're independent of the rendered size.
 * 8 clusters x 4 seats = 32 seats per tile.
 */

export const TILE_W = 5506;
export const TILE_H = 3072;

const X = {
  L1: 515 / TILE_W,
  L2: 835 / TILE_W,
  L3: 1315 / TILE_W,
  L4: 1614 / TILE_W,
  R1: 3030 / TILE_W,
  R2: 3350 / TILE_W,
  R3: 3830 / TILE_W,
  R4: 4150 / TILE_W,
};

const Y = {
  R1: 1103 / TILE_H,
  R2: 1425 / TILE_H,
  R3: 1675 / TILE_H,
  R4: 2005 / TILE_H,
};

export const CLUSTERS: [number, number][][] = [
  [
    [X.L1, Y.R1],
    [X.L2, Y.R1],
    [X.L1, Y.R2],
    [X.L2, Y.R2],
  ],
  [
    [X.L3, Y.R1],
    [X.L4, Y.R1],
    [X.L3, Y.R2],
    [X.L4, Y.R2],
  ],
  [
    [X.L1, Y.R3],
    [X.L2, Y.R3],
    [X.L1, Y.R4],
    [X.L2, Y.R4],
  ],
  [
    [X.L3, Y.R3],
    [X.L4, Y.R3],
    [X.L3, Y.R4],
    [X.L4, Y.R4],
  ],
  [
    [X.R1, Y.R1],
    [X.R2, Y.R1],
    [X.R1, Y.R2],
    [X.R2, Y.R2],
  ],
  [
    [X.R3, Y.R1],
    [X.R4, Y.R1],
    [X.R3, Y.R2],
    [X.R4, Y.R2],
  ],
  [
    [X.R1, Y.R3],
    [X.R2, Y.R3],
    [X.R1, Y.R4],
    [X.R2, Y.R4],
  ],
  [
    [X.R3, Y.R3],
    [X.R4, Y.R3],
    [X.R3, Y.R4],
    [X.R4, Y.R4],
  ],
];

export const SEATS_PER_CLUSTER = 4;
export const CLUSTERS_PER_TILE = CLUSTERS.length;

// Center point of each cluster (average of the 4 seat positions) used to place desks
export const CLUSTER_CENTERS: [number, number][] = CLUSTERS.map((seats) => {
  const avgX = seats.reduce((a, [x]) => a + x, 0) / seats.length;
  const avgY = seats.reduce((a, [, y]) => a + y, 0) / seats.length;
  return [avgX, avgY];
});
