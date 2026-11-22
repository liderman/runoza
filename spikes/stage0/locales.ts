import {I18N} from '@gravity-ui/i18n';
export const dictionaries = {
 en: {title:'Runoza compatibility lab', theme:'Switch theme', stream:'Stream response', long:'Load 500 messages', empty:'Clear', error:'Simulate error', failed:'The provider is unavailable. Try again.', answer:'A streamed **Markdown** response.\n\n```ts\nconst locale = "en";\n```'},
 ru: {title:'Проверка совместимости Runoza', theme:'Сменить тему', stream:'Потоковый ответ', long:'Загрузить 500 сообщений', empty:'Очистить', error:'Ошибка провайдера', failed:'Провайдер недоступен. Попробуйте ещё раз.', answer:'Потоковый ответ с **Markdown**.\n\n```ts\nconst locale = "ru";\n```'},
};
export type Locale = keyof typeof dictionaries;
export function translator(locale: Locale) {
 const i = new I18N();
 i.registerKeysets('en',{app:dictionaries.en}); i.registerKeysets('ru',{app:dictionaries.ru}); i.setLang(locale);
 return (key:keyof typeof dictionaries.en) => i.i18n('app',key);
}
