export interface ViralityPromptExample {
	label: "GOOD" | "BAD";
	title: string;
	expectedOverallRange: string;
	why: string;
	snippet: string;
}

// Keep this list data-only so examples can be updated without touching scoring logic.
export const VIRALITY_PROMPT_EXAMPLES: ViralityPromptExample[] = [
	{
		label: "GOOD",
		title: "The Best Skill For Selling?",
		expectedOverallRange: "78-90",
		why:
			"Strong early hook, specific claim, practical value, clear payoff, no context dependency.",
		snippet:
			"If you could only concentrate on one, this is the most important thing... Closing... ability to get a contract over the line...",
	},
	{
		label: "GOOD",
		title: "Listening More Than Talking in Sales",
		expectedOverallRange: "72-86",
		why:
			"Actionable framework with direct advice and clear flow from problem to solution to outcome.",
		snippet:
			"Listening more than talking... what are your pain points?... come back with a clear solution... move into a strong position.",
	},
	{
		label: "GOOD",
		title: "Retention Is A Silent Killer",
		expectedOverallRange: "80-92",
		why:
			"High urgency, concrete examples, tactical recommendations, emotionally charged language.",
		snippet:
			"Not understanding retention value... if a player loses money on day one... be proactive... never underestimate data.",
	},
	{
		label: "GOOD",
		title: "Cold Call Pattern Interrupt",
		expectedOverallRange: "82-94",
		why:
			"Immediate pattern-break hook, practical tactic, strong conversational examples, high retention momentum.",
		snippet:
			"What is the average prospect used to hearing... I have to break that pattern... triggers curiosity... familiar tone so you don't hang up.",
	},
	{
		label: "GOOD",
		title: "B2B 6.7 Decision Makers Insight",
		expectedOverallRange: "76-89",
		why:
			"Clear claim backed by a data point, direct relevance to target audience, practical takeaway.",
		snippet:
			"If you've ever been in B2B sales... average company has 6.7 decision makers and influencers... involve both decision makers and influencers.",
	},
	{
		label: "GOOD",
		title: "Give Away Free To Sell Bigger",
		expectedOverallRange: "82-95",
		why:
			"Strong question-led hook, contrarian advice, concrete example chain, and a clear strategic payoff.",
		snippet:
			"What's the best way to market?... give something away for free... not freemium, free... then sell something bigger.",
	},
];
