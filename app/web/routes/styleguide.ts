import { Router } from 'express';
import type { RankedEntry } from '../../types/domain.js';
import { viewContext } from '../middleware/context.js';
import { renderPage } from '../views/lib/render.js';
import { StyleguidePage } from '../views/pages/Styleguide.js';

/**
 * 开发态的组件库总览。
 *
 * 两个用途：设计系统的可视检查点（对比度、键盘走查都在这一页做），
 * 以及孤儿样式的探照灯——某个组件被删掉后，它的样式还留在这里就会露出来。
 */
export const styleguideRouter = Router();

const SAMPLE_RANKS = [
  'SubtierRookie',
  'SubtierNovice',
  'SubtierCadet',
  'SubtierSpecialist',
  'SubtierAce',
  'SubtierMaster',
  'SubtierGrandmaster',
  '打错的段位名'
];

const SAMPLE_ENTRIES: RankedEntry[] = [
  {
    id: 'demo-1',
    player: 'SharkIrene',
    rank: 'SubtierGrandmaster',
    points: 1240,
    testServer: 'Pico Test #3',
    tiers: { Sword: 'HT1', Axe: 'LT2', Crystal: 'HT3' },
    position: 1,
    createdAt: '',
    updatedAt: ''
  },
  {
    id: 'demo-2',
    player: 'AVeryLongPlayerNameThatWraps',
    rank: 'SubtierMaster',
    points: 980,
    testServer: null,
    tiers: { Sword: 'LT1' },
    position: 2,
    createdAt: '',
    updatedAt: ''
  },
  {
    id: 'demo-3',
    player: 'Bronze',
    rank: 'SubtierCadet',
    points: 980,
    testServer: null,
    tiers: {},
    position: 2,
    createdAt: '',
    updatedAt: ''
  },
  {
    id: 'demo-4',
    player: 'Rookie',
    rank: 'SubtierRookie',
    points: 120,
    testServer: null,
    tiers: { Axe: 'LT5' },
    position: 4,
    createdAt: '',
    updatedAt: ''
  }
];

styleguideRouter.get('/', (req, res) => {
  renderPage(
    res,
    StyleguidePage({ ctx: viewContext(res), ranks: SAMPLE_RANKS, entries: SAMPLE_ENTRIES })
  );
});
