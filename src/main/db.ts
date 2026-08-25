import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'

let db: Database.Database | null = null

export interface CandidateProfileRow {
  id: number
  full_name: string
  resume: string
  job_title: string
  job_description: string
  key_skills: string
  created_at: string
  updated_at: string
}

export function getDb(): Database.Database {
  if (db) return db

  const userDataPath = app.getPath('userData')
  db = new Database(join(userDataPath, 'interview-assistant.db'))

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')

  // ------------------------------------------------------------
  // Schema
  // ------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      resume TEXT NOT NULL DEFAULT '',
      job_title TEXT NOT NULL DEFAULT '',
      job_description TEXT NOT NULL DEFAULT '',
      key_skills TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES candidate_profiles(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS qa_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES interview_sessions(id),
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'audio',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_qa_session ON qa_log(session_id);
  `)

  return db
}

export function saveProfile(profile: {
  fullName: string
  resume: string
  jobTitle: string
  jobDescription: string
  keySkills: string[]
}): CandidateProfileRow {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO candidate_profiles (full_name, resume, job_title, job_description, key_skills)
    VALUES (@fullName, @resume, @jobTitle, @jobDescription, @keySkills)
  `)
  const info = stmt.run({
    fullName: profile.fullName,
    resume: profile.resume,
    jobTitle: profile.jobTitle,
    jobDescription: profile.jobDescription,
    keySkills: JSON.stringify(profile.keySkills)
  })
  return getProfileById(info.lastInsertRowid as number)
}

export function getLatestProfile(): CandidateProfileRow | undefined {
  const database = getDb()
  return database
    .prepare('SELECT * FROM candidate_profiles ORDER BY updated_at DESC LIMIT 1')
    .get() as CandidateProfileRow | undefined
}

function getProfileById(id: number): CandidateProfileRow {
  const database = getDb()
  const row = database.prepare('SELECT * FROM candidate_profiles WHERE id = ?').get(id) as
    | CandidateProfileRow
    | undefined
  if (!row) throw new Error(`Failed to save profile (id=${id})`)
  return row
}
