export interface AdditionCandidate {
  tidal_album_id: string | number;
  [key: string]: unknown;
}

export interface AdditionPlan<T extends AdditionCandidate> {
  pilot: T[];
  remaining: T[];
  skippedAlreadySaved: string[];
}

export function createAdditionPlan<T extends AdditionCandidate>(
  candidates: T[],
  libraryAlbumIds: Iterable<string>,
  pilotSize = 10,
): AdditionPlan<T> {
  const library = new Set(libraryAlbumIds);
  const unique = new Map<string, T>();
  const skippedAlreadySaved: string[] = [];

  for (const candidate of candidates) {
    const id = String(candidate.tidal_album_id ?? "");
    if (!id || unique.has(id)) continue;
    if (library.has(id)) {
      skippedAlreadySaved.push(id);
      continue;
    }
    unique.set(id, candidate);
  }

  const pending = [...unique.values()];
  return {
    pilot: pending.slice(0, pilotSize),
    remaining: pending.slice(pilotSize),
    skippedAlreadySaved,
  };
}
