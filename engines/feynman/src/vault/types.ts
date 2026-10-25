export const NOTE_STATUSES = ["draft", "review", "evergreen", "stale", "deprecated", "archive"] as const;
export const NOTE_TYPES = ["note", "raw", "index", "moc", "interim", "source-analysis"] as const;
export const SOURCE_TIERS = ["ground_truth", "institutional", "practitioner", "commentary", "unknown"] as const;
export const CONTENT_TYPES = ["paper", "docs", "article", "blog", "forum", "dataset", "policy", "code", "book", "transcript", "review", "unknown"] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type NoteType = (typeof NOTE_TYPES)[number];
export type SourceTier = (typeof SOURCE_TIERS)[number];
export type ContentType = (typeof CONTENT_TYPES)[number];

export interface NoteFrontmatter {
	title: string;
	id: string;
	tags: string[];
	created: string;
	updated?: string;
	source?: string;
	source_domain?: string;
	fetched_at?: string;
	fetch_provider?: string;
	status: NoteStatus;
	type: NoteType;
	tier?: SourceTier;
	content_type?: ContentType;
	aliases: string[];
	parent?: string;
	deprecated: boolean;
	reviewed?: string;
	expires?: string;
	word_count?: number;
	summary?: string;
	doi?: string;
	utility_score?: number;
	authority_score?: number;
	citation_count?: number;
	venue?: string;
	is_retracted?: boolean;
	oa_url?: string;
	oa_source?: string;
	oa_version?: string;
	oa_license?: string;
	oa_recovery_kind?: "substituted" | "rescued";
	claims?: Array<string | Record<string, unknown>>;
	[key: string]: unknown;
}

export interface ParsedNote {
	frontmatter: NoteFrontmatter;
	body: string;
	path: string;
}

export interface VaultNoteSummary {
	id: string;
	title: string;
	path: string;
	status: NoteStatus;
	type: NoteType;
	tier?: SourceTier;
	contentType?: ContentType;
	source?: string;
	created: string;
	updated?: string;
	wordCount: number;
	tags: string[];
	aliases: string[];
	qualityScore?: number;
	utilityScore?: number;
	authorityScore?: number;
	independence?: number;
	doi?: string;
	venue?: string;
	citationCount?: number;
	oaUrl?: string;
	oaSource?: string;
	oaVersion?: string;
	oaLicense?: string;
	oaRecoveryKind?: "substituted" | "rescued";
	isRetracted: boolean;
}

export interface VaultSearchResult extends VaultNoteSummary {
	snippet: string;
	score: number;
}

export interface VaultClaim {
	id: number;
	noteId: string;
	claim: string;
	quotedSupport?: string;
	numbers?: unknown;
	confidence?: string;
	evidenceType?: string;
	stanceTarget?: string;
	stance?: string;
	runId?: string;
	createdAt: string;
}

export interface VaultPaths {
	root: string;
	dir: string;
	notesDir: string;
	indexDir: string;
	database: string;
	temporaryDir: string;
	archiveDir: string;
	runsDir: string;
}
