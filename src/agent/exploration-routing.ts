export const EXPLORATION_REMINDER = explorationReminder(3);

export function explorationReminder(budget: number): string {
  return `[System reminder: the parent has used ${budget} inline discovery queries this turn. If broader exploration remains, spawn the explorer agent to keep raw search output out of the parent context. Continue inline only for a final targeted lookup. Do not duplicate searches delegated to the explorer.]`;
}

export class ExplorationRoutingTracker {
  private discoveryQueries = 0;
  private reminderEmitted = false;

  constructor(private readonly budget = 3) {}

  recordSuccessfulQuery(explorerActive: boolean): string | undefined {
    this.discoveryQueries++;
    if (this.reminderEmitted || explorerActive || this.discoveryQueries < this.budget) {
      return undefined;
    }
    this.reminderEmitted = true;
    return explorationReminder(this.budget);
  }

  snapshot(): { discoveryQueries: number; reminderEmitted: boolean } {
    return {
      discoveryQueries: this.discoveryQueries,
      reminderEmitted: this.reminderEmitted,
    };
  }
}
