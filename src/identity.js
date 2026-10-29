import { createHash } from "node:crypto";

const first =
  "Amber Arctic Aspen Azure Birch Brisk Cedar Coral Dawn Dune Ember Fern Flint Frost Golden Harbor Indigo Ivory Jade Juniper Lunar Maple Misty Moss Olive Opal Quiet River Silver Solar Stone Willow".split(
    " ",
  );
const last =
  "Albatross Avocet Bunting Crane Curlew Dove Egret Falcon Finch Gannet Heron Ibis Jay Kestrel Kingfisher Kite Lark Loon Magpie Martin Merlin Oriole Osprey Owl Puffin Raven Robin Sandpiper Sparrow Swift Tern Wren".split(
    " ",
  );

// Names are allocated synchronously after async validation, including within batches.
// Retired records remain in the reservation set, so their names are never recycled.
export function allocateName(id, reserved) {
  const size = first.length * last.length;
  const start = createHash("sha256").update(id).digest().readUInt32BE(0) % size;
  for (let n = 0; ; n++) {
    const index = (start + n) % size;
    const cycle = Math.floor(n / size);
    const name = `${first[Math.floor(index / last.length)]} ${last[index % last.length]}${cycle ? ` ${cycle + 1}` : ""}`;
    if (!reserved.has(name.toLowerCase())) {
      reserved.add(name.toLowerCase());
      return name;
    }
  }
}
