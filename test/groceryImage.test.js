import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeImageUrl,
  cleanGroceryQuery,
  buildCandidateQueries,
} from '../src/services/groceryImage.js';

test('isSafeImageUrl allows only trusted HTTPS image hosts', () => {
  assert.equal(isSafeImageUrl('https://www.themealdb.com/images/ingredients/Banana-Small.png'), true);
  assert.equal(isSafeImageUrl('https://thumb.wikimedia.org/wikipedia/commons/thumb/4/46/Kheer.jpg/330px-Kheer.jpg'), true);
  assert.equal(isSafeImageUrl('https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg'), true);
  assert.equal(isSafeImageUrl('http://www.themealdb.com/images/ingredients/Banana-Small.png'), false);
  assert.equal(isSafeImageUrl('data:image/png;base64,AAA'), false);
  assert.equal(isSafeImageUrl('https://evil.example.com/a.png'), false);
  assert.equal(isSafeImageUrl(''), false);
});

test('cleanGroceryQuery strips weights and quantities cleanly', () => {
  assert.equal(cleanGroceryQuery('Chicken 2 kg'), 'Chicken');
  assert.equal(cleanGroceryQuery('Curd (500 g)'), 'Curd');
  assert.equal(cleanGroceryQuery('Milk 1 litre'), 'Milk');
  assert.equal(cleanGroceryQuery('Biryani Masala 1 packet'), 'Biryani Masala');
});

test('buildCandidateQueries resolves Indian, Malayalam, and compound items', () => {
  const curd = buildCandidateQueries('Curd');
  assert.ok(curd.includes('Yogurt'));

  const mlMilk = buildCandidateQueries('പാൽ');
  assert.ok(mlMilk.includes('Milk'));

  const mlBanana = buildCandidateQueries('ഏത്തപ്പഴം');
  assert.ok(mlBanana.includes('Banana'));

  const payasam = buildCandidateQueries('payasam');
  assert.ok(payasam.includes('Kheer'));

  const herbs = buildCandidateQueries('Coriander and Mint Leaves');
  assert.ok(herbs.includes('Coriander Leaves'));
  assert.ok(herbs.includes('Mint'));
});

