/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './i-reveal.module.css';

/**
 * IReveal's class names. Kept out of the 'use client' module so Server Components can read them: a value
 * imported from a client module is only a reference on the server, and reading a property of it throws.
 */
export const reveal = { section: styles.reveal, rise: styles.rise, pop: styles.pop };
