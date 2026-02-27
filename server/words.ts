/**
 * Word pool for Pictionary game.
 * Each word has a category hint shown to the player.
 */

export interface WordEntry {
    word: string;
    category: string;
}

export const WORD_POOL: WordEntry[] = [
    // Animals
    { word: "cat", category: "animal" },
    { word: "dog", category: "animal" },
    { word: "elephant", category: "animal" },
    { word: "fish", category: "animal" },
    { word: "butterfly", category: "animal" },
    { word: "penguin", category: "animal" },
    { word: "snake", category: "animal" },
    { word: "owl", category: "animal" },

    // Objects
    { word: "house", category: "object" },
    { word: "car", category: "object" },
    { word: "bicycle", category: "object" },
    { word: "umbrella", category: "object" },
    { word: "guitar", category: "object" },
    { word: "clock", category: "object" },
    { word: "lamp", category: "object" },
    { word: "key", category: "object" },

    // Nature
    { word: "sun", category: "nature" },
    { word: "moon", category: "nature" },
    { word: "tree", category: "nature" },
    { word: "flower", category: "nature" },
    { word: "mountain", category: "nature" },
    { word: "rainbow", category: "nature" },
    { word: "volcano", category: "nature" },
    { word: "snowflake", category: "nature" },

    // Food
    { word: "pizza", category: "food" },
    { word: "apple", category: "food" },
    { word: "cake", category: "food" },
    { word: "icecream", category: "food" },
    { word: "banana", category: "food" },
    { word: "hamburger", category: "food" },

    // Transport
    { word: "airplane", category: "transport" },
    { word: "boat", category: "transport" },
    { word: "rocket", category: "transport" },
    { word: "train", category: "transport" },

    // Space & Science
    { word: "planet", category: "space" },
    { word: "star", category: "space" },
    { word: "robot", category: "science" },

    // Misc
    { word: "crown", category: "object" },
    { word: "sword", category: "object" },
    { word: "castle", category: "building" },
    { word: "lighthouse", category: "building" },
    { word: "windmill", category: "building" },
    { word: "bridge", category: "structure" },
    { word: "heart", category: "symbol" },
    { word: "diamond", category: "shape" },
    { word: "ghost", category: "character" },
    { word: "pirate", category: "character" },
];

export function pickRandomWord(): WordEntry {
    return WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)];
}
