/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CardsS5 } from './CardsS5';
import { FilmS5 } from './FilmS5';

/**
 * S5's backdrop: the scene cards, and over them the first screen's film under its frame — so a card passing behind the
 * first screen is hidden by the picture and only ever shows on the grey page.
 */
export function SceneS5() {
  return <><CardsS5 /><FilmS5 /></>;
}
