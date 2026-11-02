// Model, effort and speed, checked against the models the Codex account
// offers (model/list) before an agent is queued, so a wrong name fails at once
// instead of when the agent finally starts.

// A model by its full id, or among the listed ones by short name ("sol" for
// gpt-6.1-sol) or display name. A short name several models share picks the
// first Codex lists, its newest.
export function findModel(models, name) {
  const wanted = name.trim().toLowerCase();
  const listed = models.filter((m) => !m.hidden);
  return (
    models.find((m) => m.id.toLowerCase() === wanted) ??
    listed.find((m) => m.id.toLowerCase().split("-").pop() === wanted) ??
    listed.find((m) => m.displayName?.toLowerCase() === wanted)
  );
}

// The Codex service tier a turn asks for: "default" (standard speed), or the
// model's Fast tier.
const fastTier = (model) =>
  (model.serviceTiers ?? []).find(
    (tier) => tier.id === "fast" || tier.name?.toLowerCase() === "fast",
  );

// The model's full id and the service tier for a choice of model, effort and
// speed; throws with what the account offers instead. of says where the
// model came from, for the message ("The workspace's model").
export function checkModelChoice(models, { model, effort, speed, of }) {
  const chosen = findModel(models, model);
  if (!chosen)
    throw new Error(
      `${of ?? "Model"} ${model} is not one this Codex account offers. Available: ${models
        .filter((m) => !m.hidden)
        .map((m) => m.id)
        .join(", ")}.`,
    );
  const efforts = (chosen.supportedReasoningEfforts ?? []).map(
    (e) => e.reasoningEffort,
  );
  if (effort && efforts.length && !efforts.includes(effort))
    throw new Error(
      `${chosen.id} does not support effort ${effort}. It supports ${efforts.join(", ")}.`,
    );
  if (speed !== "fast") return { model: chosen.id, serviceTier: "default" };
  const tier = fastTier(chosen);
  if (!tier)
    throw new Error(
      `${chosen.id} has no fast tier.${chosen.serviceTiers?.length ? ` Its tiers: ${chosen.serviceTiers.map((t) => t.name).join(", ")}.` : ""}`,
    );
  return { model: chosen.id, serviceTier: tier.id };
}
