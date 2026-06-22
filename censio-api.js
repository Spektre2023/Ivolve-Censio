// ============================================================
//  CENSIO — front-end data layer
//  Drop this in next to index.html and load it before the app.
//  It replaces the simulated handlers with real Supabase + Worker calls.
//  All values below are PUBLIC (the anon key is protected by Row Level
//  Security). Secrets (service_role / Claude / Resend) live ONLY in the Worker.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://khttsxgfwuxvzyzdtrno.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_zTQSiruLouWFVufxw0n05w_e3KyBHtp";
export const WORKER_URL = "https://censio-api.schan-b9e.workers.dev";
export const APP_URL = "https://ivolve-censio.pages.dev";

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- AUTH ----------
export async function signIn(email, password) {
  return db.auth.signInWithPassword({ email, password });
}
export async function setFirstPassword(password) {
  return db.auth.updateUser({ password }); // for the first-time / reset flow
}
export async function signOut() { return db.auth.signOut(); }
export async function hasSession() {
  const { data: { session } } = await db.auth.getSession();
  return !!session;
}
export async function currentProfile() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  // Try with the company name embedded; fall back to a plain select if the
  // embed errors, and to a synthetic profile if the row is missing — so a
  // signed-in user is NEVER treated as "not real" (which would show demo data).
  let { data, error } = await db.from("profiles").select("*, companies:company_id(name)").eq("id", user.id).single();
  if (error) {
    const r = await db.from("profiles").select("*").eq("id", user.id).single();
    data = r.data; error = r.error;
  }
  if (error || !data) {
    console.warn("[censio] profile row not found for", user.id, error);
    return {
      id: user.id, email: user.email,
      full_name: (user.user_metadata && user.user_metadata.full_name) || "",
      role: null, is_team: false, is_admin: false, _missing: true,
    };
  }
  return data;
}
export async function resetPassword(email) {
  return db.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
}

// ---------- PROJECTS ----------
export async function myProjects() {
  // RLS automatically limits this to projects the user is a member of
  // (Ivolve team & admins see everything).
  const { data } = await db.from("projects")
    .select("*, assets(count), project_members(count)")
    .order("updated_at", { ascending: false });
  return data || [];
}
export async function createProject(p) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("projects").insert({
    name: p.name, code: p.code || null, meta: p.meta || null,
    status: p.status || "Active", created_by: user ? user.id : null,
  }).select().single();
}
export async function updateProjectStatus(id, status) {
  return db.from("projects").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
}
export async function joinProject(projectId) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("project_members").insert({ project_id: projectId, profile_id: user.id });
}
export async function myMemberships() {
  const { data: { user } } = await db.auth.getUser();
  const { data } = await db.from("project_members").select("project_id").eq("profile_id", user.id);
  return (data || []).map((r) => r.project_id);
}
export async function projectMembers(projectId) {
  const { data } = await db.from("project_members")
    .select("*, profiles:profile_id(full_name, role)")
    .eq("project_id", projectId);
  return data || [];
}
export async function memberProjects(profileId) {
  const { data } = await db.from("project_members").select("project_id").eq("profile_id", profileId);
  return (data || []).map((r) => r.project_id);
}
export async function addMember(projectId, profileId, isApprover) {
  return db.from("project_members").upsert({ project_id: projectId, profile_id: profileId, is_approver: !!isApprover });
}
export async function removeMember(projectId, profileId) {
  return db.from("project_members").delete().eq("project_id", projectId).eq("profile_id", profileId);
}

// ---------- PEOPLE / COMPANIES (admin) ----------
export async function allProfiles() {
  const { data } = await db.from("profiles")
    .select("*, companies:company_id(name)")
    .order("full_name");
  return data || [];
}
export async function listCompanies() {
  const { data } = await db.from("companies").select("*").order("name");
  return data || [];
}

// ---------- ASSETS ----------
export async function currentAssets(projectId) {
  const { data } = await db.from("assets")
    .select("*").eq("project_id", projectId).eq("is_current", true)
    .order("view_no");
  return data || [];
}
export async function assetById(assetId) {
  const { data } = await db.from("assets").select("*").eq("id", assetId).single();
  return data;
}
// Direct signed URL for an image in storage (1h). Works for anyone allowed to
// read the object by storage RLS (team, or project members via schema_v6).
export async function signedImage(path, bucket) {
  if (!path) return null;
  const { data, error } = await db.storage.from(bucket || "renders").createSignedUrl(path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
export async function uploadAsset(projectId, file, meta) {
  const path = `${projectId}/${Date.now()}_${file.name}`;
  const up = await db.storage.from("renders").upload(path, file, { upsert: false });
  if (up.error) return up;
  // If this supersedes a previous asset, retire that one (keeps history; only ADDs state).
  if (meta.supersedesId) {
    await db.from("assets").update({ is_current: false }).eq("id", meta.supersedesId);
  }
  const ins = await db.from("assets").insert({
    project_id: projectId, filename: file.name, storage_path: path, original_path: path,
    revision: meta.revision, view_no: meta.view, type: meta.type, media: meta.media || "image",
    requested_roles: meta.roles, artist_notes: meta.notes,
    supersedes_id: meta.supersedesId || null,
  }).select().single();
  // Fire-and-forget: web-optimise + build the review PDF (Edge Function).
  // The image is usable immediately; storage_path swaps to the optimised file when done.
  if (!ins.error && ins.data && (meta.media || "image") !== "video") {
    try { db.functions.invoke("optimize-asset", { body: { assetId: ins.data.id } }); } catch (e) { /* non-blocking */ }
  }
  return ins;
}
export async function optimizeAsset(assetId) {
  return db.functions.invoke("optimize-asset", { body: { assetId } });
}

// ---------- COMMENTS / MARKUPS ----------
export async function getComments(assetId) {
  const { data } = await db.from("comments")
    .select("*, profiles:author_id(full_name, role), vetoer:vetoed_by(full_name)")
    .eq("asset_id", assetId).order("n");
  return data || [];
}
export async function addComment(assetId, c) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("comments").insert({
    asset_id: assetId, author_id: user.id, n: c.n,
    x: c.x, y: c.y, shape: c.shape || null, tag: c.tag,
    body: c.text, attachment_path: c.attachment || null,
  }).select("*, profiles:author_id(full_name, role)").single();
}
export async function updateComment(id, patch) {
  return db.from("comments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}
export async function deleteComment(id) {
  return db.from("comments").delete().eq("id", id);
}
// Veto / un-veto a comment (Authoriser, Client, or Admin — enforced by RLS).
export async function vetoComment(id, vetoed) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("comments").update({
    vetoed: !!vetoed,
    vetoed_by: vetoed ? user.id : null,
    vetoed_at: vetoed ? new Date().toISOString() : null,
  }).eq("id", id);
}
// Designate (or clear) a project's authoriser. Admin only (RLS).
export async function setAuthoriser(projectId, profileId) {
  return db.from("projects").update({ authoriser_id: profileId || null }).eq("id", projectId);
}

// ---------- APPROVALS ----------
// Approving records *this reviewer's* sign-off (insert is allowed by RLS).
// The asset-level approved/locked flag is owned by the Ivolve team.
export async function approveAsset(assetId) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("approvals").insert({ asset_id: assetId, approver_id: user.id });
}
export async function unapproveAsset(assetId) {
  const { data: { user } } = await db.auth.getUser();
  return db.from("approvals").delete().eq("asset_id", assetId).eq("approver_id", user.id);
}
export async function myApprovals(assetIds) {
  if (!assetIds || !assetIds.length) return [];
  const { data: { user } } = await db.auth.getUser();
  const { data } = await db.from("approvals").select("asset_id")
    .eq("approver_id", user.id).in("asset_id", assetIds);
  return (data || []).map((r) => r.asset_id);
}

// ---------- SECURE WORKER CALLS (Claude / email / downloads / admin) ----------
async function callWorker(path, opts = {}) {
  const { data: { session } } = await db.auth.getSession();
  const r = await fetch(WORKER_URL + path, {
    ...opts,
    headers: { ...(opts.headers || {}), "content-type": "application/json",
               Authorization: `Bearer ${session?.access_token}` },
  });
  return r.json();
}
export const aiReview    = (assetId)        => callWorker("/api/ai/review", { method: "POST", body: JSON.stringify({ assetId }) });
export const notify      = (payload)        => callWorker("/api/notify",   { method: "POST", body: JSON.stringify(payload) });
export const downloadUrl = (assetId, mode)  => callWorker(`/api/download?assetId=${assetId}&mode=${mode || "original"}`);
// Admin: create + invite a consultant (legacy invite-email flow).
export const inviteConsultant = (payload)   => callWorker("/api/admin/consultant", { method: "POST", body: JSON.stringify(payload) });

// ---------- FRICTIONLESS ONBOARDING ----------
// One default password everyone gets; the app forces a change on first sign-in.
export const DEFAULT_PASSWORD = "Censio2026!";
// Batch-create accounts directly (no invite email). users: [{full_name,email,role,company,is_team,password}]
export const createUsers   = (users)   => callWorker("/api/admin/create-users", { method: "POST", body: JSON.stringify({ users }) });
// Admin sets/overrides a user's password (and shows it in the panel).
export const setUserPassword = (payload) => callWorker("/api/admin/set-password", { method: "POST", body: JSON.stringify(payload) });
export const updateUserAccount = (payload) => callWorker("/api/admin/update-user", { method: "POST", body: JSON.stringify(payload) });
export const deleteUser = (userId) => callWorker("/api/admin/delete-user", { method: "POST", body: JSON.stringify({ userId }) });
// The signed-in user changes their own password; we also store it readable for admin.
export async function changeMyPassword(newPassword) {
  const up = await db.auth.updateUser({ password: newPassword });
  if (up.error) return up;
  const { data: { user } } = await db.auth.getUser();
  if (user) await db.from("profiles").update({ visible_password: newPassword, must_change_password: false }).eq("id", user.id);
  return { data: up.data, error: null };
}
