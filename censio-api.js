// ============================================================
//  CENSIO — front-end data layer
//  Drop this in next to index.html and load it before the app.
//  It replaces the simulated handlers with real Supabase + Worker calls.
//  Fill in the two URLs / key below (all PUBLIC, safe in the browser —
//  the anon key is protected by Row Level Security).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-PUBLIC-ANON-KEY";
export const WORKER_URL = "https://censio-api.YOUR-SUBDOMAIN.workers.dev";

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- AUTH ----------
export async function signIn(email, password) {
  return db.auth.signInWithPassword({ email, password });
}
export async function setFirstPassword(password) {
  return db.auth.updateUser({ password }); // for the first-time / reset flow
}
export async function signOut() { return db.auth.signOut(); }
export async function currentProfile() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data } = await db.from("profiles").select("*").eq("id", user.id).single();
  return data;
}

// ---------- PROJECTS ----------
export async function myProjects() {
  // RLS automatically limits this to projects the user is a member of
  const { data } = await db.from("projects")
    .select("*, assets(count)")
    .order("updated_at", { ascending: false });
  return data || [];
}
export async function joinProject(projectId) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("project_members").insert({ project_id: projectId, profile_id: user.id });
}

// ---------- ASSETS ----------
export async function currentAssets(projectId) {
  const { data } = await db.from("assets")
    .select("*").eq("project_id", projectId).eq("is_current", true);
  return data || [];
}
export async function uploadAsset(projectId, file, meta) {
  const path = `${projectId}/${Date.now()}_${file.name}`;
  await db.storage.from("renders").upload(path, file, { upsert: false });
  // optimisation + PDF conversion happen in a Supabase Edge Function on upload.
  return db.from("assets").insert({
    project_id: projectId, filename: file.name, storage_path: path,
    revision: meta.revision, view_no: meta.view, type: meta.type,
    requested_roles: meta.roles, artist_notes: meta.notes,
    supersedes_id: meta.supersedesId || null,
  });
}

// ---------- COMMENTS / MARKUPS ----------
export async function getComments(assetId) {
  const { data } = await db.from("comments")
    .select("*, profiles:author_id(full_name, role)")
    .eq("asset_id", assetId).order("n");
  return data || [];
}
export async function addComment(assetId, c) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("comments").insert({
    asset_id: assetId, author_id: user.id, n: c.n,
    x: c.x, y: c.y, shape: c.shape || null, tag: c.tag,
    body: c.text, attachment_path: c.attachment || null,
  });
}
export async function updateComment(id, patch) {
  return db.from("comments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}
export async function approveAsset(assetId) {
  const { data: { user } } = await db.auth.getUser();
  await db.from("approvals").insert({ asset_id: assetId, approver_id: user.id });
  return db.from("assets").update({ approved: true, locked: true }).eq("id", assetId);
}

// ---------- SECURE WORKER CALLS (Claude / email / downloads) ----------
async function callWorker(path, opts = {}) {
  const { data: { session } } = await db.auth.getSession();
  const r = await fetch(WORKER_URL + path, {
    ...opts,
    headers: { ...(opts.headers || {}), "content-type": "application/json",
               Authorization: `Bearer ${session?.access_token}` },
  });
  return r.json();
}
export const aiReview   = (assetId)        => callWorker("/api/ai/review", { method: "POST", body: JSON.stringify({ assetId }) });
export const notify     = (payload)        => callWorker("/api/notify",   { method: "POST", body: JSON.stringify(payload) });
export const downloadUrl = (assetId, mode) => callWorker(`/api/download?assetId=${assetId}&mode=${mode}`);
