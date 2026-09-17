// src/lib/legal-search/engine/concept-lexicon.ts
// Curated Armenian legal concept lexicon with English/Russian equivalents
// and related search phrases. Used for semantic query understanding (§8),
// query expansion (§9) and multilingual expansion (§11).
//
// Matching is Armenian-morphology tolerant: we match concept keys as
// substrings of the normalized query (Armenian is agglutinative; full
// stemming is out of scope, so keys are stored in multiple inflected forms).

import type { LegalConcept } from "../types";

export type LexiconEntry = {
  hy: string;
  en: string;
  ru: string;
  /** Armenian surface forms / related phrases for detection + expansion. */
  forms: string[];
  /** Extra Armenian phrases to use as retrieval variants. */
  relatedPhrases: string[];
  /** Concept domain — used for intent hints. */
  domain:
    | "criminal_procedure"
    | "criminal_law"
    | "civil_procedure"
    | "civil_law"
    | "administrative"
    | "constitutional"
    | "evidence"
    | "fundamental_rights"
    | "procedure_general"
    | "echr";
};

export const CONCEPT_LEXICON: LexiconEntry[] = [
  // ---- Criminal procedure -------------------------------------------------
  {
    hy: "քրեական վարույթի նախաձեռնում",
    en: "initiation of criminal proceedings",
    ru: "возбуждение уголовного дела",
    forms: ["վարույթի նախաձեռնում", "վարույթ նախաձեռնել", "քրեական գործ հարուցել", "գործի նախաձեռնում", "նախաձեռնել"],
    relatedPhrases: ["քրեական վարույթ նախաձեռնելու հիմքեր", "հանցանքի հատկանիշների հայտնաբերում"],
    domain: "criminal_procedure",
  },
  {
    hy: "խուզարկություն",
    en: "search and seizure",
    ru: "обыск и выемка",
    forms: ["խուզարկություն", "խուզարկութ", "խուզարկել", "խուզարկ", "մարմնական զննում"],
    relatedPhrases: ["խուզարկության հիմքեր", "խուզարկության կարգ", "դատավորի որոշում խուզարկության մասին"],
    domain: "criminal_procedure",
  },
  {
    hy: "ձերբակալություն",
    en: "arrest and detention",
    ru: "задержание и арест",
    forms: ["ձերբակալություն", "ձերբակալ", "կալանք", "կալանքի տակ"],
    relatedPhrases: ["ձերբակալության կարգ", "կալանքի ժամկետներ", "ազատությունից զրկում"],
    domain: "criminal_procedure",
  },
  {
    hy: "մեղադրանք",
    en: "indictment and accusation",
    ru: "обвинение",
    forms: ["մեղադրանք", "մեղադրանք առաջադրել", "մեղադրյալ", "մեղադրել"],
    relatedPhrases: ["մեղադրանքի առաջադրում", "մեղադրյալի իրավունքներ"],
    domain: "criminal_procedure",
  },
  {
    hy: "կասկածյալ",
    en: "suspect",
    ru: "подозреваемый",
    forms: ["կասկածյալ", "կասկածվող"],
    relatedPhrases: ["կասկածյալի իրավունքներ", "կասկածյալի կարգավիճակ"],
    domain: "criminal_procedure",
  },
  {
    hy: "անմեղության կանխավարկած",
    en: "presumption of innocence",
    ru: "презумпция невиновности",
    forms: ["անմեղության կանխավարկած", "անմեղ է քանի դեռ"],
    relatedPhrases: ["անմեղության կանխավարկածի սկզբունք"],
    domain: "fundamental_rights",
  },
  {
    hy: "քրեական պատասխանատվություն",
    en: "criminal liability",
    ru: "уголовная ответственность",
    forms: ["քրեական պատասխանատվություն", "քրեական պատժամիջոց"],
    relatedPhrases: ["քրեական պատասխանատվության հիմքեր", "պատժամիջոցների տեսակներ"],
    domain: "criminal_law",
  },
  {
    hy: "ինքնահանձնում",
    en: "voluntary surrender",
    ru: "явка с повинной",
    forms: ["ինքնահանձնում", "ինքնակամ հանձնվել"],
    relatedPhrases: [],
    domain: "criminal_procedure",
  },
  {
    hy: "վարույթի կասեցում",
    en: "suspension of proceedings",
    ru: "приостановление производства",
    forms: ["վարույթի կասեցում", "վարույթը կասեցնել", "կասեցված վարույթ"],
    relatedPhrases: [],
    domain: "procedure_general",
  },
  {
    hy: "քրեական գործի դադարեցում",
    en: "termination of criminal case",
    ru: "прекращение уголовного дела",
    forms: ["դադարեցում", "գործը դադարեցնել", "քրեական հետապնդումից ազատել"],
    relatedPhrases: ["ռեաբիլիտացիայի հիմքերով դադարեցում"],
    domain: "criminal_procedure",
  },
  // ---- Evidence ------------------------------------------------------------
  {
    hy: "ապացույցների թույլատրելիություն",
    en: "admissibility of evidence",
    ru: "допустимость доказательств",
    forms: ["ապացույցների թույլատրելիություն", "թույլատրելի ապացույց", "անթույլատրելի ապացույց"],
    relatedPhrases: ["ապացույցների գնահատում", "ապացույցներ ձեռք բերելու կարգ"],
    domain: "evidence",
  },
  {
    hy: "ապացույցներ ձեռք բերելու կանոնների խախտում",
    en: "unlawfully obtained evidence",
    ru: "недопустимые (полученные с нарушением) доказательства",
    forms: ["խախտմամբ ձեռք բերված", "օրենքի խախտմամբ ստացված"],
    relatedPhrases: ["ապացույցների բացառում"],
    domain: "evidence",
  },
  {
    hy: "վկայի ցուցմունք",
    en: "witness testimony",
    ru: "показания свидетеля",
    forms: ["վկայի ցուցմունք", "վկա", "ցուցմունք տալ"],
    relatedPhrases: ["վկայի իրավունքներ", "վկայի պաշտպանություն"],
    domain: "evidence",
  },
  {
    hy: "դատական փորձաքննություն",
    en: "judicial expert examination",
    ru: "судебная экспертиза",
    forms: ["փորձաքննություն", "փորձագետ", "փորձաքննության եզրակացություն"],
    relatedPhrases: ["փորձագետի եզրակացություն"],
    domain: "evidence",
  },
  // ---- Notification & fair trial -------------------------------------------
  {
    hy: "պատշաճ ծանուցում",
    en: "proper notification of proceedings",
    ru: "надлежащее извещение",
    forms: ["պատշաճ ծանուցում", "ծանուցում", "ծանուցվ", "չծանուցվ", "ծանուցել", "ծանուցման", "ծանուց"],
    relatedPhrases: [
      "դատական նիստի ծանուցում",
      "կողմերի ծանուցում",
      "անձի բացակայությամբ դատական նիստ",
    ],
    domain: "procedure_general",
  },
  {
    hy: "արդար դատաքննության իրավունք",
    en: "right to a fair trial",
    ru: "право на справедливое судебное разбирательство",
    forms: ["արդար դատաքննություն", "արդար դատ", "դատաքննության իրավունք"],
    relatedPhrases: ["Article 6", "արդար դատավարության երաշխիքներ"],
    domain: "echr",
  },
  {
    hy: "պաշտպանի իրավունք",
    en: "right to defence and legal assistance",
    ru: "право на защиту",
    forms: ["պաշտպանի օգնություն", "փաստաբան", "պաշտպանության իրավունք", "պաշտպան"],
    relatedPhrases: ["պաշտպանի մասնակցություն", "անվճար իրավաբանական օգնություն"],
    domain: "fundamental_rights",
  },
  {
    hy: "դատարան դիմելու իրավունք",
    en: "right of access to a court",
    ru: "право на обращение в суд",
    forms: ["դատարան դիմելու իրավունք", "դատական պաշտպանության իրավունք"],
    relatedPhrases: [],
    domain: "fundamental_rights",
  },
  {
    hy: "գործի քննում ողջամիտ ժամկետում",
    en: "trial within a reasonable time",
    ru: "разбирательство в разумный срок",
    forms: ["ողջամիտ ժամկետ", "գործի երկարաձգում", "չարաշահում"],
    relatedPhrases: ["գործի քննում ողջամիտ ժամկետներում"],
    domain: "echr",
  },
  {
    hy: "օրինական դատավոր",
    en: "lawful (natural) judge",
    ru: "законный судья",
    forms: ["օրինական դատավոր", "դատավորի կազմ"],
    relatedPhrases: [],
    domain: "fundamental_rights",
  },
  {
    hy: "անձնական կյանքի անձեռնմխելիություն",
    en: "private and family life",
    ru: "частная и семейная жизнь",
    forms: ["անձնական կյանք", "ընտանիքի անձեռնմխելիություն", "մասնավոր կյանք"],
    relatedPhrases: ["Article 8", "անձնական կյանքի գաղտնիք"],
    domain: "fundamental_rights",
  },
  {
    hy: "բնակարանի անձեռնմխելիություն",
    en: "inviolability of the home",
    ru: "неприкосновенность жилища",
    forms: ["բնակարանի անձեռնմխելիություն", "բնակարան մտնել"],
    relatedPhrases: ["բնակարան մտնելու կարգ"],
    domain: "fundamental_rights",
  },
  {
    hy: "գույքի իրավունք",
    en: "right to property",
    ru: "право собственности",
    forms: ["սեփականության իրավունք", "գույքի իրավունք", "սեփականաշնորհում", "բռնագանձում"],
    relatedPhrases: ["Article 1 Protocol 1", "գույքի բռնագանձում"],
    domain: "fundamental_rights",
  },
  {
    hy: "արտահանձնում և վտարում",
    en: "extradition and expulsion",
    ru: "экстрадиция и выдворение",
    forms: ["արտահանձնում", "վտարում", "արտաքսում"],
    relatedPhrases: [],
    domain: "fundamental_rights",
  },
  {
    hy: "խոշտանգումների արգելում",
    en: "prohibition of torture and inhuman treatment",
    ru: "запрет пыток",
    forms: ["խոշտանգում", "անմարդկային վերաբերմունք", "դաժան վերաբերմունք"],
    relatedPhrases: ["Article 3", "խոշտանգման արգելում"],
    domain: "echr",
  },
  {
    hy: "ազատության իրավունք",
    en: "right to liberty and security",
    ru: "право на свободу и личную неприкосновенность",
    forms: ["ազատության իրավունք", "անձնական ազատություն"],
    relatedPhrases: ["Article 5", "ազատությունից զրկման օրինականություն"],
    domain: "echr",
  },
  {
    hy: "խոսքի ազատություն",
    en: "freedom of expression",
    ru: "свобода слова",
    forms: ["խոսքի ազատություն", "կարծիքի ազատություն", "մամուլի ազատություն"],
    relatedPhrases: ["Article 10", "արտահայտվելու ազատություն"],
    domain: "echr",
  },
  {
    hy: "հավաքների ազատություն",
    en: "freedom of assembly",
    ru: "свобода собраний",
    forms: ["հավաքների ազատություն", "հանրահավաք", "հանրահավաքի"],
    relatedPhrases: ["Article 11", "խաղաղ հավաքներ"],
    domain: "echr",
  },
  {
    hy: "խտրականության արգելում",
    en: "prohibition of discrimination",
    ru: "запрет дискриминации",
    forms: ["խտրականություն", "հավասար իրավունքներ", "խտրական"],
    relatedPhrases: ["Article 14", "հավասարություն օրենքի առջև"],
    domain: "echr",
  },
  // ---- Civil ---------------------------------------------------------------
  {
    hy: "հայց",
    en: "claim and lawsuit",
    ru: "иск",
    forms: ["հայց", "հայցադիմում", "դատական հայց", "հայցվոր"],
    relatedPhrases: ["հայցի առարկա", "հայցային վարույթ"],
    domain: "civil_procedure",
  },
  {
    hy: "ժամկետների վերականգնում",
    en: "restoration of missed time-limits",
    ru: "восстановление пропущенных сроков",
    forms: ["ժամկետների վերականգնում", "բաց թողնված ժամկետ", "ժամկետը բաց է թողնվել"],
    relatedPhrases: ["դատական ժամկետներ"],
    domain: "procedure_general",
  },
  {
    hy: "վերաքննիչ բողոքարկում",
    en: "appeal",
    ru: "апелляционное обжалование",
    forms: ["վերաքննիչ բողոք", "բողոքարկում", "վերաքննիչ դատարան"],
    relatedPhrases: ["բողոքարկման ժամկետ", "վերաքննիչ կարգ"],
    domain: "procedure_general",
  },
  {
    hy: "վճռաբեկ բողոքարկում",
    en: "cassation appeal",
    ru: "кассационное обжалование",
    forms: ["վճռաբեկ բողոք", "վճռաբեկ դատարան", "վճռաբեկ կարգ"],
    relatedPhrases: ["վճռաբեկ բողոքի ընդունելիություն", "նախադեպային որոշում"],
    domain: "procedure_general",
  },
  {
    hy: "դատարանական ծախսեր",
    en: "court costs",
    ru: "судебные расходы",
    forms: ["դատարանական ծախսեր", "պետական տուրք", "ծախսերի բաշխում"],
    relatedPhrases: ["դատարանական ծախսերի վերադարձ"],
    domain: "procedure_general",
  },
  {
    hy: "պայմանագիր",
    en: "contract",
    ru: "договор",
    forms: ["պայմանագիր", "պայմանագրի խախտում", "գործարք"],
    relatedPhrases: ["պայմանագրի անվավերություն", "պայմանագրի կատարում"],
    domain: "civil_law",
  },
  {
    hy: "վնասի հատուցում",
    en: "compensation for damage",
    ru: "возмещение ущерба",
    forms: ["վնասի հատուցում", "վնաս հատուցել", "բարոյական վնաս", "ոչ գույքային վնաս"],
    relatedPhrases: ["վնասի չափը", "հատուցման կարգ"],
    domain: "civil_law",
  },
  {
    hy: "սնանկություն",
    en: "bankruptcy and insolvency",
    ru: "банкротство",
    forms: ["սնանկություն", "սնանկ", "պարտապան"],
    relatedPhrases: ["սնանկության վարույթ", "վարկատուների պահանջներ"],
    domain: "civil_law",
  },
  {
    hy: "ժառանգություն",
    en: "inheritance and succession",
    ru: "наследство",
    forms: ["ժառանգություն", "ժառանգ", "ժառանգման իրավունք"],
    relatedPhrases: ["ժառանգության բացվում", "կտակ"],
    domain: "civil_law",
  },
  {
    hy: "աշխատանքային հարաբերություններ",
    en: "employment relations",
    ru: "трудовые отношения",
    forms: ["աշխատանքային", "աշխատանքի ընդունում", "աշխատանքից ազատում", "ազատում աշխատանքից"],
    relatedPhrases: ["աշխատանքային պայմանագիր", "աշխատավարձ"],
    domain: "civil_law",
  },
  {
    hy: "ընտանեկան հարաբերություններ",
    en: "family relations",
    ru: "семейные отношения",
    forms: ["ամուսնություն", "ամուսնալուծություն", "երեխայի խնամք", "ալիմենտ"],
    relatedPhrases: ["ամուսնության լուծում", "ծնողական իրավունքներ"],
    domain: "civil_law",
  },
  // ---- Administrative --------------------------------------------------------
  {
    hy: "վարչական ակտ",
    en: "administrative act",
    ru: "административный акт",
    forms: ["վարչական ակտ", "վարչական որոշում", "անհատական վարչական ակտ"],
    relatedPhrases: ["վարչական ակտի վիրավորականություն", "վարչական ակտի չեղարկում"],
    domain: "administrative",
  },
  {
    hy: "վարչական իրավախախտում",
    en: "administrative offence",
    ru: "административное правонарушение",
    forms: ["վարչական իրավախախտում", "վարչական տուգանք"],
    relatedPhrases: ["վարչական տուգանքի չափ"],
    domain: "administrative",
  },
  {
    hy: "պետական մարմնի գործողության բողոքարկում",
    en: "challenge of state body action",
    ru: "обжалование действий госоргана",
    forms: ["պետական մարմնի գործողություն", "բողոք պետական մարմնի դեմ"],
    relatedPhrases: ["վարչական դատարան դիմել"],
    domain: "administrative",
  },
  // ---- Constitutional -------------------------------------------------------
  {
    hy: "սահմանադրական վերահսկողություն",
    en: "constitutional review",
    ru: "конституционный контроль",
    forms: ["սահմանադրական դատարան", "սահմանադրական վերահսկողություն", "սահմանադրականություն"],
    relatedPhrases: ["օրենքի սահմանադրականություն", "իրավունքի նորմի սահմանադրականություն"],
    domain: "constitutional",
  },
  {
    hy: "իրավունքի մեկնաբանություն",
    en: "interpretation of law",
    ru: "толкование права",
    forms: ["մեկնաբանություն", "նորմի մեկնաբանություն", "իրավունքի նորմ"],
    relatedPhrases: [],
    domain: "constitutional",
  },
  // ---- General procedure ------------------------------------------------------
  {
    hy: "դատական նիստ",
    en: "court hearing",
    ru: "судебное заседание",
    forms: ["դատական նիստ", "նիստը տեղի է ունեցել", "նիստ անցկացնել", "դատալսում"],
    relatedPhrases: ["նիստի հետաձգում", "բաց դատական նիստ"],
    domain: "procedure_general",
  },
  {
    hy: "կողմերի իրավահավասարություն",
    en: "equality of arms",
    ru: "равенство сторон",
    forms: ["իրավահավասարություն", "կողմերի հավասարություն"],
    relatedPhrases: [],
    domain: "echr",
  },
  {
    hy: "միջանկյալ որոշում",
    en: "interim decision",
    ru: "промежуточное решение",
    forms: ["միջանկյալ որոշում", "միջնորդություն"],
    relatedPhrases: [],
    domain: "procedure_general",
  },
  {
    hy: "կատարում",
    en: "enforcement and execution",
    ru: "исполнение",
    forms: ["կատարող", "հարկադիր կատարում", "որոշման կատարում"],
    relatedPhrases: ["դատական ակտի կատարում"],
    domain: "procedure_general",
  },
  {
    hy: "մարմնավորում և վերակազմակերպում",
    en: "legal entity",
    ru: "юридическое лицо",
    forms: ["իրավաբանական անձ",  "ՍՊԸ", "ԲԲԸ", "վերակազմակերպում"],
    relatedPhrases: ["իրավաբանական անձի պատասխանատվություն"],
    domain: "civil_law",
  },
  {
    hy: "գործով եզրակացություն",
    en: "judgment reasoning",
    ru: "мотивировка решения",
    forms: ["եզրակացություն",  "վճռի հիմնավորում",  "մոտիվավորում"],
    relatedPhrases: ["վճռի պատճառաբանություն"],
    domain: "procedure_general",
  },
];

/** Detect lexicon concepts present in the normalized query text. */
export function detectConcepts(normalizedQuery: string): LegalConcept[] {
  if (!normalizedQuery) return [];
  const q = normalizedQuery.toLowerCase();
  const found: LegalConcept[] = [];
  const seen = new Set<string>();

  for (const entry of CONCEPT_LEXICON) {
    let matched = false;
    for (const form of entry.forms) {
      const f = form.toLowerCase();
      // Substring match both ways: form in query OR query token set overlaps.
      if (f.length >= 4 && q.includes(f)) {
        matched = true;
        break;
      }
    }
    if (matched && !seen.has(entry.hy)) {
      seen.add(entry.hy);
      found.push({
        hy: entry.hy,
        en: entry.en,
        ru: entry.ru,
        relatedPhrases: entry.relatedPhrases,
        detectedBy: "lexicon",
      });
    }
  }

  return found;
}

/** Find a lexicon entry by its Armenian key (for LLM-extracted concepts). */
export function findConceptByHy(hy: string): LexiconEntry | undefined {
  const h = hy.toLowerCase().trim();
  return CONCEPT_LEXICON.find((e) => e.hy.toLowerCase() === h);
}
