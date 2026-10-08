/**
 * Legacy Race Strategy page (v1.0.6). The feature now lives in the Race Day
 * hub (/race): the Strategy tab is `components/race/StrategyPanel`. This file
 * stays as a re-export so the old route and imports keep working (the router
 * redirects /race-strategy to /race, keeping ?tab=).
 */
export { default } from './RaceDay';
