'use strict';
// تشغيل: node test_normalizer.js
const assert = require('assert');
const { localSudaneseNormalizer: n, applyQafMapping } = require('./normalizer');

const cases = [
  // كلمات لا يجب أن تتغير (كانت تتشوه في النسخة القديمة)
  ['قاعدة', 'قاعدة'],
  ['مقال', 'مقال'],
  ['أوقات', 'أوقات'],
  ['ظلم', 'ظلم'],
  ['دائماً', 'دائماً'],
  ['بقال', 'بقال'], // سابقة "ب" غير مسموحة مع "قال"
  ['هسي', 'هسي'],

  // استبدالات صحيحة
  ['الآن', 'هَسِّي'],
  ['الان', 'هَسِّي'],
  ['جداً', 'شَديدْ'],
  ['جدا', 'شَديدْ'],
  ['الوقت', 'الوَگِتْ'],
  ['وقال', 'وگالْ'],
  ['فوق', 'فُوگْ'],
  ['ماذا', 'شِنو'],
  ['هذا الكتاب', 'دَه الكتاب'],

  // عبارات كاملة، بعلامة الاستفهام وبدونها
  ['ماذا تريد أن تفعل الآن؟', 'داير تِعمِلْ شِنو هَسِّي؟'],
  ['ماذا تريد أن تفعل الآن', 'داير تِعمِلْ شِنو هَسِّي؟'],
  ['هذا الأمر جيد جداً', 'الموضوع دَه سَمِحْ شَديدْ'],
  ['هذا الأمر جيد جدا', 'الموضوع دَه سَمِحْ شَديدْ'],

  // لا استبدال مزدوج: "أريد أن" → "داير" ثم لا يُعاد لمس الناتج
  ['أريد أن أذهب', 'داير أذهب'],
  ['أريد كتاباً', 'داير كتاباً'],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = n(input);
  try {
    assert.strictEqual(actual, expected);
  } catch (e) {
    failed++;
    console.error(`✗ "${input}"\n    المتوقع: ${expected}\n    الفعلي:  ${actual}`);
  }
}

// قاموس القاف→گاف الخارجي
const kb = { phonetic_rules: { qaf_to_gaf_mapping: { تقدم: 'تگدم' } } };
for (const [input, expected] of [
  ['التقدم كبير', 'التگدم كبير'],
  ['متقدم', 'متقدم'],
]) {
  const actual = n(input, kb);
  try {
    assert.strictEqual(actual, expected);
  } catch (e) {
    failed++;
    console.error(`✗ kb "${input}"\n    المتوقع: ${expected}\n    الفعلي:  ${actual}`);
  }
}
const cal = applyQafMapping('تقدم', kb.phonetic_rules.qaf_to_gaf_mapping);
assert.strictEqual(cal.text, 'تگدم');
assert.strictEqual(cal.changes.length, 1);

if (failed) {
  console.error(`\n${failed} اختبار فشل`);
  process.exit(1);
}
console.log(`✓ نجحت كل الاختبارات (${cases.length + 3})`);
