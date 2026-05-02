/**
 * Narrative-arc templates. Pre-built deck skeletons that drop a structured
 * outline into the canvas without going through deck-from-brief. Each slide
 * has a `name`, `prompt`, `suggestedFormat`, and `notes` — the same shape
 * the deck-from-brief endpoint returns.
 *
 * The user still has to Cook each slide (or "Cook all"); templates only
 * provide the structure and prompt scaffolding. This keeps templates fast,
 * deterministic, and predictable, while letting AI do the actual content
 * generation on a single click.
 */

import type { FormatOverride } from "./ai/helpers";

export type TemplateSlide = {
  name: string;
  prompt: string;
  suggestedFormat: FormatOverride;
  notes: string;
};

export type Template = {
  id: string;
  name: string;
  /** One-sentence description of what this template is for. */
  blurb: string;
  /** Optional short label shown next to the title (e.g. "8 slides"). */
  scope: string;
  slides: TemplateSlide[];
};

const PITCH: Template = {
  id: "pitch",
  name: "Investor pitch",
  blurb: "Classic seed/Series-A arc. Problem, solution, market, traction, ask.",
  scope: "8 slides",
  slides: [
    {
      name: "Title",
      prompt:
        "An editorial title slide for a startup pitch. Big company name, a single confident tagline beneath it. Hero illustration that feels modern and ambitious — not a stock photo.",
      suggestedFormat: "image",
      notes: "Land the room with confidence. Pause for 2 seconds before speaking."
    },
    {
      name: "The problem",
      prompt:
        "A bullets slide describing 3-4 specific, concrete pains your target customer feels today. Use real numbers where possible (hours wasted, dollars lost). Avoid platitudes.",
      suggestedFormat: "bullets",
      notes:
        "Anchor the pain. The bullets should make the audience nod, not raise eyebrows. Don't oversell."
    },
    {
      name: "Our solution",
      prompt:
        "A bullets slide explaining the 3 things our product actually does that solve the problem above. Each bullet starts with a verb. Concrete, no jargon.",
      suggestedFormat: "bullets",
      notes: "This is the wedge. Be specific about what we do and what we don't."
    },
    {
      name: "How it works",
      prompt:
        "A grid slide with 3 cards showing the product's core mechanics. Each card has a 2-3 word title and a 1-sentence body explaining what happens.",
      suggestedFormat: "grid",
      notes: "Show the magic in 30 seconds. Don't go deep into engineering."
    },
    {
      name: "Why now",
      prompt:
        "A bullets slide listing 3 macro shifts (regulatory, technical, behavioral) that make this the right moment for this company.",
      suggestedFormat: "bullets",
      notes: "Investors care more about timing than novelty. Sell the inflection."
    },
    {
      name: "Traction",
      prompt:
        "A stats slide with 3 metrics showing momentum: pick from revenue/users/retention/growth-rate. Use real numbers if you have them, [PLACEHOLDER] if you don't.",
      suggestedFormat: "stats",
      notes: "If a number doesn't make us look strong, leave it off. Be honest, not impressive."
    },
    {
      name: "Team",
      prompt:
        "A grid slide with 3 cards introducing the founding team. Each card: name + role on top, 1-sentence credibility line beneath.",
      suggestedFormat: "grid",
      notes: "Highlight relevant pattern-matching: prior exits, domain expertise, customer empathy."
    },
    {
      name: "The ask",
      prompt:
        "A title slide with a clear, specific ask: amount raising, what it funds, and what milestone it gets us to. Keep it to one short headline + one subhead.",
      suggestedFormat: "title",
      notes: "Be specific. 'Raising $X to do Y so we can hit Z by [date].' No fluff."
    }
  ]
};

const INTERNAL_UPDATE: Template = {
  id: "internal-update",
  name: "Internal update",
  blurb: "Weekly or monthly team update. Wins, gaps, next steps.",
  scope: "6 slides",
  slides: [
    {
      name: "Title",
      prompt:
        "A title slide for a team update. Big headline naming the period (e.g. 'October 2026 update'), small subhead with the team or project name.",
      suggestedFormat: "title",
      notes: "Set context fast. The audience knows the format — get to the substance."
    },
    {
      name: "Where we are",
      prompt:
        "A bullets slide with 3 sentences summarizing current state: what's on track, what's at risk, what's blocked. Read like a status report, not a cheerleading exercise.",
      suggestedFormat: "bullets",
      notes: "Honest snapshot. If something is at risk, say so plainly."
    },
    {
      name: "Wins",
      prompt:
        "A bullets slide listing 3-5 specific things shipped or hit since the last update. Each bullet starts with a verb in past tense.",
      suggestedFormat: "bullets",
      notes: "Credit the people who did the work, not just the work itself."
    },
    {
      name: "Numbers",
      prompt:
        "A stats slide with 3 metrics that quantify the period — pick the metrics most relevant to your team's goals. Use real numbers or [PLACEHOLDER].",
      suggestedFormat: "stats",
      notes: "Lean into the metrics that drive decisions. Skip vanity stats."
    },
    {
      name: "Gaps and risks",
      prompt:
        "A bullets slide listing 2-3 things slipping or in trouble, each with a one-line root-cause guess. No surprises later.",
      suggestedFormat: "bullets",
      notes: "Pre-empt the questions you don't want surprised in the room."
    },
    {
      name: "Next 30 days",
      prompt:
        "A bullets slide with 3-5 concrete commitments for the next month. Each bullet is verb + outcome + (optionally) date.",
      suggestedFormat: "bullets",
      notes: "These are commitments, not aspirations. We'll be held to them."
    }
  ]
};

const LAUNCH: Template = {
  id: "launch",
  name: "Product launch",
  blurb: "External announcement. What's launching, why now, what to do.",
  scope: "6 slides",
  slides: [
    {
      name: "Title",
      prompt:
        "A bold hero image slide announcing a product launch. The product name should be visually dominant. Editorial, not loud.",
      suggestedFormat: "image",
      notes: "Build anticipation. Don't speak immediately — let the slide land."
    },
    {
      name: "What's launching",
      prompt:
        "A title slide with the product name as headline and a one-sentence positioning statement as subtitle.",
      suggestedFormat: "title",
      notes: "If you can't pitch it in one sentence, the launch isn't ready."
    },
    {
      name: "Why now",
      prompt:
        "A bullets slide explaining the customer/market shift that makes this launch matter today, in 3 bullets.",
      suggestedFormat: "bullets",
      notes: "Connect the launch to a real change in the world, not just internal roadmap timing."
    },
    {
      name: "How it works",
      prompt:
        "A grid slide with 3 cards walking through the user flow. Each card: short title + 1-sentence description.",
      suggestedFormat: "grid",
      notes: "Demo would be better than this slide. Use this only if a live demo isn't possible."
    },
    {
      name: "Early proof",
      prompt:
        "A stats slide with 2-3 numbers from beta or early customers — adoption, retention, NPS, time saved. Use real numbers or [PLACEHOLDER].",
      suggestedFormat: "stats",
      notes: "Even small numbers from real customers beat big numbers from internal tests."
    },
    {
      name: "Get started",
      prompt:
        "A title slide with the call to action — where to sign up, when general availability is, who to contact. Specific and actionable.",
      suggestedFormat: "title",
      notes: "End with one clear action. Don't bury the URL."
    }
  ]
};

const RETRO: Template = {
  id: "retro",
  name: "Project retro",
  blurb: "Honest post-mortem. What worked, what didn't, what we'd do differently.",
  scope: "5 slides",
  slides: [
    {
      name: "Title",
      prompt:
        "A title slide naming the project being reviewed and the date span it covers.",
      suggestedFormat: "title",
      notes: "Lay out the scope clearly so the conversation stays focused."
    },
    {
      name: "What worked",
      prompt:
        "A bullets slide with 3-5 specific things that went well. Be specific — 'X feature shipped 2 weeks ahead' beats 'great teamwork'.",
      suggestedFormat: "bullets",
      notes: "Celebrate genuine wins. Vague compliments are insulting."
    },
    {
      name: "What didn't",
      prompt:
        "A bullets slide with 3-5 specific things that didn't go well. Name the problem, not the people.",
      suggestedFormat: "bullets",
      notes: "Soft on people, hard on the work. Set the tone before the conversation starts."
    },
    {
      name: "What we learned",
      prompt:
        "A bullets slide with 3-4 generalized lessons from the issues above — things that would apply to the next project too.",
      suggestedFormat: "bullets",
      notes: "Lessons are only useful if they're transferable. If a lesson is project-specific, drop it."
    },
    {
      name: "What we'll change",
      prompt:
        "A bullets slide with 2-4 concrete process changes for the next project — not aspirations, actual changes.",
      suggestedFormat: "bullets",
      notes: "Specific, owned commitments. 'We'll be more thoughtful' is not a commitment."
    }
  ]
};

export const TEMPLATE_LIST: Template[] = [PITCH, INTERNAL_UPDATE, LAUNCH, RETRO];

export function getTemplate(id: string): Template | null {
  return TEMPLATE_LIST.find((t) => t.id === id) ?? null;
}
