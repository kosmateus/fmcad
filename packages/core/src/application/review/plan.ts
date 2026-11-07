import type {
  ReviewCaptureRecipe,
  ReviewOrientation,
  ReviewPlan,
  ReviewRequest,
} from "./contracts.js";

/** Expected report order; SDK camera setup remains in the canonical Python adapter. */
export const REVIEW_VIEWS = Object.freeze([
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "iso-top-left",
  "iso-bottom-right",
]);

const ORIENTATIONS: readonly ReviewOrientation[] = Object.freeze([
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "iso-top-left",
  "iso-bottom-right",
  "iso-top-right",
  "iso-bottom-left",
]);
const RECIPE_KEYS: Record<ReviewCaptureRecipe["kind"], readonly string[]> = {
  orientation: ["kind", "name", "orientation"],
  roi: ["extents", "kind", "name", "orientation", "target"],
  detail: ["kind", "name", "orientation", "scale", "target"],
  section: ["kind", "name", "orientation", "sectionName", "visible"],
};

export const DEFAULT_REVIEW_RECIPES: readonly ReviewCaptureRecipe[] =
  Object.freeze(
    REVIEW_VIEWS.map((name) =>
      Object.freeze({
        name,
        kind: "orientation" as const,
        orientation: name as ReviewOrientation,
      }),
    ),
  );

export function validateReviewRequest(request: ReviewRequest): void {
  if (typeof request.doc !== "string" || !request.doc.trim())
    throw new Error("review requires --doc <name>");
  if (
    typeof request.docId !== "string" &&
    typeof request.docFileId !== "string"
  )
    throw new Error("review requires --doc-id or --doc-file-id");
  for (const [name, value] of [
    ["--doc-id", request.docId],
    ["--doc-file-id", request.docFileId],
  ] as const) {
    if (
      value !== null &&
      (typeof value !== "string" ||
        !value ||
        /\s/.test(value) ||
        value.startsWith("-"))
    )
      throw new Error(
        `${name} requires a nonempty identity without whitespace`,
      );
  }
  if (!request.out || !request.fusionOut || !request.requestId)
    throw new Error("review requires output paths and a request identity");
  for (const [name, value] of [
    ["--width", request.width],
    ["--height", request.height],
  ] as const) {
    if (!Number.isInteger(value) || value < 32 || value > 4096)
      throw new Error(`${name} must be an integer from 32 to 4096`);
  }
  if (request.width * request.height > 16000000)
    throw new Error("review images must not exceed 16 megapixels");
  if (request.recipes !== undefined) validateRecipes(request.recipes);
}

function validateRecipes(recipes: readonly ReviewCaptureRecipe[]): void {
  if (!Array.isArray(recipes) || recipes.length < 1 || recipes.length > 32)
    throw new Error("review recipes must contain from 1 to 32 entries");
  const names = new Set<string>();
  for (const recipe of recipes) {
    if (
      !recipe ||
      typeof recipe !== "object" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(recipe.name) ||
      names.has(recipe.name)
    )
      throw new Error("review recipe names must be unique safe filenames");
    names.add(recipe.name);
    if (!ORIENTATIONS.includes(recipe.orientation))
      throw new Error("review recipe has an unsupported orientation");
    if (
      JSON.stringify(Object.keys(recipe).sort()) !==
      JSON.stringify(RECIPE_KEYS[recipe.kind as ReviewCaptureRecipe["kind"]])
    )
      throw new Error("review recipe has unsupported fields or kind");
    if (recipe.kind === "orientation") continue;
    if (recipe.kind === "roi") {
      validatePoint(recipe.target, "ROI target");
      validateExtents(recipe.extents, "ROI extents");
      continue;
    }
    if (recipe.kind === "detail") {
      validatePoint(recipe.target, "detail target");
      if (
        !Number.isFinite(recipe.scale) ||
        recipe.scale < 0.05 ||
        recipe.scale > 0.75
      )
        throw new Error("detail scale must be from 0.05 to 0.75");
      continue;
    }
    if (recipe.kind === "section") {
      if (typeof recipe.sectionName !== "string" || !recipe.sectionName.trim())
        throw new Error("section recipe requires a section name");
      if (typeof recipe.visible !== "boolean")
        throw new Error("section recipe visibility must be boolean");
      continue;
    }
    throw new Error(
      "review recipe kind must be orientation, roi, detail, or section",
    );
  }
}

function validatePoint(value: readonly number[], label: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => !Number.isFinite(coordinate))
  )
    throw new Error(
      label + " must contain three finite Fusion centimetre values",
    );
}

function validateExtents(value: readonly number[], label: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((extent) => !Number.isFinite(extent) || extent <= 0)
  )
    throw new Error(
      label + " must contain two positive Fusion centimetre values",
    );
}

export function planReview(request: ReviewRequest): ReviewPlan {
  validateReviewRequest(request);
  const recipes = (request.recipes ?? DEFAULT_REVIEW_RECIPES).map((recipe) =>
    Object.freeze({
      ...recipe,
      ...(recipe.kind === "roi" || recipe.kind === "detail"
        ? { target: Object.freeze([...recipe.target]) }
        : {}),
      ...(recipe.kind === "roi"
        ? { extents: Object.freeze([...recipe.extents]) }
        : {}),
    }),
  ) as readonly ReviewCaptureRecipe[];
  return Object.freeze({
    operation: "review",
    views: Object.freeze(recipes.map((recipe) => recipe.name)),
    recipes: Object.freeze(recipes),
    request: Object.freeze({ ...request, recipes: Object.freeze(recipes) }),
  });
}
