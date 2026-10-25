export type ScaleProfileName = "full" | "premier";
export type ResearchTier = "pending" | "light" | "full" | "dissertation";
export type ReportFormat = "short" | "structured" | "argumentative" | "dissertation";

export interface ScaleProfile {
	name: ScaleProfileName;
	description: string;
	steps: string[];
	sourceMin: number;
	sourceTarget: [number, number];
	plannedSearches: [number, number];
	candidateUrls: [number, number];
	dedupedUrls: [number, number];
	depthBudget: number;
	lociMax: number;
	draftCount: number;
	wordTargets: Record<ReportFormat, [number, number]>;
	citationDensityMin: number;
	critics: boolean;
	chapterCount?: [number, number];
}

const fullSteps = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "14.5", "15", "16"];

export const SCALE_PROFILES: Record<ScaleProfileName, ScaleProfile> = {
	full: {
		name: "full",
		description: "Adversarially audited research: 55–80 sources, triple draft, full critic suite.",
		steps: fullSteps,
		sourceMin: 45,
		sourceTarget: [55, 80],
		plannedSearches: [40, 100],
		candidateUrls: [80, 120],
		dedupedUrls: [60, 100],
		depthBudget: 40,
		lociMax: 6,
		draftCount: 3,
		wordTargets: { short: [500, 2000], structured: [2000, 5000], argumentative: [5000, 10000], dissertation: [25000, 80000] },
		citationDensityMin: 9,
		critics: true,
	},
	premier: {
		name: "premier",
		description: "Maximum flat-pipeline scale: 100–130 sources with double depth budget and extended reports.",
		steps: fullSteps,
		sourceMin: 90,
		sourceTarget: [100, 130],
		plannedSearches: [80, 160],
		candidateUrls: [150, 220],
		dedupedUrls: [120, 180],
		depthBudget: 80,
		lociMax: 10,
		draftCount: 3,
		wordTargets: { short: [500, 2000], structured: [3000, 8000], argumentative: [8000, 16000], dissertation: [25000, 80000] },
		citationDensityMin: 9,
		critics: true,
	},
};

export function resolveScaleProfile(name: string | undefined): ScaleProfile {
	const key = (name ?? "full").trim().toLowerCase() as ScaleProfileName;
	const profile = SCALE_PROFILES[key];
	if (!profile) throw new Error(`Unknown research profile '${name}'. Choose ${Object.keys(SCALE_PROFILES).join(", ")}.`);
	return structuredClone(profile);
}

export function resolveResearchTier(tier: ResearchTier, profile: ScaleProfile): ScaleProfile {
	if (tier === "pending") return profile;
	if (tier === "light") return {
		...profile,
		description: "Fast bounded research: 15–25 sources, one draft, no full critic suite.",
		steps: ["1", "2", "10", "15", "16"], sourceMin: 10, sourceTarget: [15, 25],
		plannedSearches: [8, 20], candidateUrls: [20, 40], dedupedUrls: [15, 30], depthBudget: 0,
		lociMax: 0, draftCount: 1, citationDensityMin: 5, critics: false,
	};
	if (tier === "dissertation") return {
		...profile,
		description: "Experimental chaptered research: 300–450 sources across 4–10 chapters.",
		steps: ["1", "1.5", ...fullSteps.slice(1)], sourceMin: 250, sourceTarget: [300, 450],
		plannedSearches: [80, 160], candidateUrls: [150, 220], dedupedUrls: [120, 180],
		depthBudget: 160, lociMax: 20, draftCount: 1, citationDensityMin: 9, critics: true, chapterCount: [4, 10],
	};
	return profile;
}
