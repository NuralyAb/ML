# Data Pipeline — From Raw Excel Files to Model-Ready Features

**Med Forecast KZ** · Bilingual guide (Russian + English) · written for
someone who has never touched the pipeline before. Every number is
reproduced from the actual code (`ml/prepare_data.py`,
`ml/build_features.py`) and the artifact metadata
(`ml/models/metadata.json`).

> Чтение «сверху вниз»: каждая глава начинается с русской версии,
> затем тот же текст по-английски, и заканчивается мини-словарём
> терминов. Если слово непонятно — пролистай в конец главы.

---

## 0. Big picture / Общая картина

### Русский
Министерство здравоохранения РК публикует на портале открытых данных
`ashyq.data.gov.kz` сырые таблицы с **каждым выписанным рецептом** в
стране. Эти таблицы — Excel-файлы, по одному за квартал на каждый из 18
регионов: всего **504 файла, ≈ 12 ГБ**. Из них нельзя обучать модель
напрямую — миллиарды строк уровня «один рецепт = одна строка», шумно
и слишком детально. Поэтому мы строим **дата-пайплайн**: серия
скриптов, которые из этой свалки делают аккуратную таблицу-«пациент»
для машинного обучения.

Конечный результат пайплайна — файл `feature_panel.parquet` (~27 МБ,
**840 694 строки**, **18 881 серия**), который читает модель LightGBM.

### English
The Kazakhstan Ministry of Health publishes the **prescription
registry** on the open-data portal `ashyq.data.gov.kz`. The raw data
is a pile of Excel spreadsheets — one per quarter per region, **504
files in total, ≈ 12 GB**. You cannot train a model on that pile
directly: it is row-per-prescription, noisy, and far too granular.
We therefore run a **data pipeline**: a chain of scripts that turn
that pile into one tidy table the model can ingest.

The pipeline's final artifact is `feature_panel.parquet` (~27 MB,
**840 694 rows**, **18 881 series**), which the LightGBM model reads.

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Прескрипционный реестр** / **prescription registry** | Государственная база данных, где хранится факт каждого выписанного врачом рецепта: дата, код диагноза по МКБ-10, клиника, регион, район, число упаковок препарата. У нас это датасет `ISLO_MEDICALHISTORYOFCITIZENS`. |
| **Open-data портал** | Сайт, где госорганы публикуют данные под открытой лицензией. У нас — `ashyq.data.gov.kz` под CC BY 4.0 (можно использовать в любых проектах с указанием источника). |
| **Data pipeline** (дата-пайплайн) | Цепочка автоматических шагов: «прочитать → почистить → агрегировать → посчитать признаки → сохранить». Каждый шаг — один скрипт с входом и выходом. |
| **Series** (серия / временной ряд) | Один объект, который меняется во времени. У нас одна серия = пара `(регион, ICD-код)`, например (Атырауская область, J20.9) — «острый бронхит в Атырау». Всего 18 881 такая пара. |
| **Parquet** | Колоночный бинарный формат для табличных данных. Жмёт в 5–10 раз сильнее CSV, читается в 10–100 раз быстрее, потому что Pandas/DuckDB могут прочитать только нужные колонки. |
| **MoH** | Ministry of Health — Министерство здравоохранения. |

---

## 1. Source of truth — what we start with / Что у нас на входе

### Русский
Скачивание данных не входит в этот пайплайн — это сделано один раз
вручную через скрипт-загрузчик (Magda API портала `ashyq`). После
загрузки на диске лежит дерево:

```
datasets/
├── Абайская область/
│   ├── 2023_Q1.xlsx
│   ├── 2023_Q2.xlsx
│   └── ...
├── Актюбинская область/
│   └── ...
└── ... (всего 18 региональных папок)
```

Один Excel-файл — это **один квартал одного региона**: десятки тысяч
строк, по одной на каждый рецепт. Колонки в файле — около двадцати, из
них для модели мы оставляем только **семь**:

| Колонка в xlsx | Что значит |
| --- | --- |
| `recipedate` | Дата выписки рецепта (год-месяц-день). |
| `icdid` | Код диагноза по МКБ-10, например `J20.9`. |
| `nozology` | Человекочитаемое название диагноза, например «Острый бронхит». |
| `region_med_organ` | Регион клиники, например «Атырауская область». |
| `raion_med_organ` | Район внутри региона, например «Махамбетский район». |
| `recipepackqty` | Сколько упаковок препарата выписано. |
| `polyclid` | ID поликлиники (числовой). |

Всё остальное (дозировка, тип медуслуги и т.д.) для прогноза количества
рецептов не нужно и игнорируется.

### English
Downloading the data is **not** part of this pipeline — that was a
one-off step using a Magda-API helper. After the download, the disk
holds this tree:

```
datasets/
├── Abay Region/
│   ├── 2023_Q1.xlsx
│   ├── 2023_Q2.xlsx
│   └── ...
├── Aktobe Region/
│   └── ...
└── ... (18 region folders in total)
```

One xlsx file = **one quarter for one region**: tens of thousands of
rows, one row per prescription. Each file has ~20 columns; for the
model we keep only **seven**:

| Column | Meaning |
| --- | --- |
| `recipedate` | Date the prescription was issued (YYYY-MM-DD). |
| `icdid` | ICD-10 diagnosis code, e.g. `J20.9`. |
| `nozology` | Human-readable diagnosis name. |
| `region_med_organ` | Region of the issuing clinic. |
| `raion_med_organ` | District within the region. |
| `recipepackqty` | Number of medicine packs prescribed. |
| `polyclid` | Clinic identifier (numeric). |

Everything else (dosage, service type, …) is irrelevant for *counting
prescriptions* and is dropped at read-time.

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **xlsx / Excel** | Бинарный формат Microsoft Excel 2007+. Архив из XML-файлов. Можно прочитать в Python библиотеками `openpyxl` или `calamine`. |
| **МКБ-10** / **ICD-10** | Международная классификация болезней, 10-я редакция. Каждой болезни присвоен код вида буква+цифры (`A04.9`, `I10`, `J20.9`). Первая буква = «глава» (J = болезни органов дыхания, I = сердечно-сосудистые, E = эндокринные/диабет и т.д.). |
| **Nozology** (нозология) | Просто «название болезни» на медицинском жаргоне. У нас — текст рядом с кодом МКБ для удобочитаемости. |
| **Region / Oblast (область) / District / Raion (район)** | Двухуровневая административная структура Казахстана. ADM1 = регион (20 единиц, в т.ч. 3 города республиканского значения), ADM2 = район (174–199 единиц). |
| **Polyclinic ID** | Уникальный номер поликлиники в государственном реестре. Нужен, чтобы посчитать сколько *разных клиник* в регионе выписали рецепт на этот диагноз — это сильный признак ёмкости. |

---

## 2. Reading + cleaning / Чтение и очистка (`prepare_data.py`)

### Русский
Скрипт `prepare_data.py` параллельно перемалывает все 504 файла. Для
каждого файла он делает:

1. **Открыть быстрым движком.** Сначала пробуем `calamine` (написан на
   Rust, в 5–10 раз быстрее openpyxl и кушает меньше памяти). Если
   файл побитый — фоллбэк на `openpyxl`.
2. **Прочитать только нужные 7 колонок** — экономим память при чтении.
3. **Распарсить дату.** `recipedate` приводится к типу datetime;
   битые даты становятся `NaT` (Not a Time).
4. **Выбросить мусор.** Если в строке отсутствует `recipedate`,
   `icdid` или `region_med_organ` — строка удаляется (без этих трёх
   полей запись бесполезна).
5. **Нормализовать строки.** Лишние пробелы убираются, регистр
   сохраняется как есть (русский «Атырауская область» = «Атырауская
   область»). Пустые `nozology` и `district` заменяются на `Unknown`.
6. **Привести `recipepackqty` к числу.** Если поле пустое — ставим 1
   (один рецепт = одна упаковка по умолчанию).
7. **Свести к месяцу.** Дата превращается в `year_month` — это
   *первое число* того месяца, например `2024-03-15` → `2024-03-01`.
   Так все рецепты одного месяца попадают в одну ячейку.
8. **Агрегировать.** Группируем по
   `(регион, район, icd-код, нозология, год-месяц)` и считаем:
   - `recipe_count` — сколько строк (= рецептов) в группе;
   - `total_packs` — сумма упаковок;
   - `n_clinics` — сколько **уникальных** поликлиник выписали этот
     диагноз в этом месяце.

После того как **все** 504 файла обработаны, скрипт делает финальный
групп-бай ещё раз — потому что один и тот же месяц может попасть в два
квартальных файла (на стыке кварталов рецепты иногда отчитываются в
обоих файлах). Полные дубли суммируются, n_clinics берётся как
максимум, чтобы не задвоить.

Результат — `monthly_panel.parquet` (~9 МБ, ≈ 1 млн строк, разрешение
`регион × район × ICD × месяц`).

### English
`prepare_data.py` grinds through all 504 files in parallel. For each
file it does:

1. **Open with a fast engine.** Try `calamine` first (Rust-backed, 5–10×
   faster than openpyxl and lower memory). On corrupt files, fall back
   to `openpyxl`.
2. **Read only the seven needed columns** — saves memory at parse-time.
3. **Parse the date.** `recipedate` is cast to `datetime`; broken dates
   become `NaT` (Not a Time).
4. **Drop junk.** Any row missing `recipedate`, `icdid` or
   `region_med_organ` is discarded (such rows are useless).
5. **Normalise strings.** Trim whitespace, keep case as-is. Missing
   `nozology` / `district` become `Unknown`.
6. **Coerce `recipepackqty` to numeric.** Empty → 1 (a prescription
   without an explicit pack count is still one prescription).
7. **Bucket by month.** The date becomes `year_month` = the *first day*
   of that month, e.g. `2024-03-15` → `2024-03-01`. All prescriptions
   in one month collapse to one bucket.
8. **Aggregate.** Group by
   `(region, district, icd_code, nozology, year_month)` and compute:
   - `recipe_count` — number of rows (= prescriptions) in the group;
   - `total_packs` — sum of packs;
   - `n_clinics` — number of **distinct** polyclinics issuing this
     diagnosis in this month.

After **all** 504 files are processed, the script does one final
group-by — because the same month can appear in two quarterly files
(prescriptions at quarter boundaries sometimes report in both).
Duplicates are summed; `n_clinics` takes the max to avoid double-
counting.

The output is `monthly_panel.parquet` (~9 MB, ≈ 1 M rows, granularity
`region × district × ICD × month`).

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Parallel processing** / `ProcessPoolExecutor` | Параллельное чтение нескольких файлов в разных процессах ОС. Ускоряет ETL в 3–4 раза. В коде используется `concurrent.futures.ProcessPoolExecutor` с 2–4 воркерами (больше — упирается в память при разжатии xlsx). |
| **Calamine engine** | Парсер Excel на Rust, который Pandas умеет использовать через `engine="calamine"`. Быстрее и легче по памяти, чем openpyxl. |
| **NaT** / **NaN** | «Not a Time» / «Not a Number» — спец-значения pandas для отсутствующих дат / чисел. Аналог `NULL` в SQL. |
| **dropna(subset=…)** | Удаляет строки, где хотя бы одна из перечисленных колонок пустая. |
| **Group-by** (группировка) | Операция «сгруппировать строки по уникальным значениям ключа и для каждой группы посчитать что-то». В SQL — `GROUP BY`, в pandas — `df.groupby(...).agg(...)`. |
| **year_month** | Месяц как timestamp = первое число этого месяца. Удобно для сортировки, рисования графиков и арифметики (`+ DateOffset(months=1)`). |
| **`recipe_count`** | Целевая переменная: сколько рецептов выписано в данном `(регион, район, ICD, месяц)`. Именно её прогнозирует модель. |
| **`n_clinics`** | Количество уникальных поликлиник, выписавших этот диагноз в этом месяце. Прокси-метрика «ёмкости» — самый сильный признак модели. |

---

## 3. The monthly panel / Месячная панель — промежуточный итог

### Русский
После шага 2 у нас есть файл `monthly_panel.parquet` со следующей
схемой:

```
region       string    "Атырауская область"
district     string    "Махамбетский район"
icdid        string    "J20.9"
nozology     string    "Острый бронхит"
year_month   datetime  2024-03-01
recipe_count int64     127
total_packs  int64     142
n_clinics    int64     3
```

Это **«длинная» (long) таблица**: одна строка = одна
комбинация (регион, район, диагноз, месяц). Если в каком-то месяце для
какой-то комбинации **не было** рецептов — строки в файле **нет** (а
не строка с нулём). Это станет важно на следующем шаге.

Размер: ~9 МБ, около 1 млн строк, охват 2018-01 → 2025-04 (Абай
расширяет диапазон до 2025-06).

### English
After step 2 we have `monthly_panel.parquet` with this schema:

```
region       string    "Atyrau Region"
district     string    "Makhambet District"
icdid        string    "J20.9"
nozology     string    "Acute bronchitis"
year_month   datetime  2024-03-01
recipe_count int64     127
total_packs  int64     142
n_clinics    int64     3
```

This is a **long-format table**: one row = one
(region, district, diagnosis, month) tuple. If a combination had
**zero** prescriptions in a given month, there is **no row at all** for
that month — not a row with zero. That will matter in the next step.

Size: ~9 MB, ≈ 1 M rows, coverage 2018-01 → 2025-04 (Abay extends to
2025-06).

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Long / wide format** | «Длинный» = одна строка на одну дату+ключ, удобно для агрегаций и `groupby`. «Широкий» = строки = ключ, колонки = даты — удобно для просмотра глазами, но плохо для ML. У нас всё в long. |
| **Panel data** | Данные, где много **серий** наблюдаются на одной и той же временной шкале. У нас 18+ тыс. серий, каждая со своей историей по месяцам. Это и есть «панель». |
| **Schema** (схема) | Список колонок таблицы с их типами. Парке хранит схему вместе с данными — поэтому при чтении pandas сразу знает, что `year_month` это datetime. |
| **Sparse series** | «Разрежённая» серия — у которой много месяцев без рецептов. Для редких ICD-кодов в маленьких районах это норма (рак щитовидки в селе с населением 3000 человек — один рецепт за пять лет). |

---

## 4. Feature engineering / Построение признаков (`build_features.py`)

### Русский
Это самый «алхимический» этап. Из месячной панели нужно собрать
таблицу, где у каждой строки уже есть **все признаки**, нужные модели
прямо сейчас, без необходимости ничего считать. Шаги:

#### 4.1. Сохраняем районный срез для дашборда
Скрипт первым делом *просто пересохраняет* всю месячную панель в
`district_panel.parquet`. На этом файле работает DuckDB-бекенд (карта,
фильтры, агрегации по районам в UI). Для **обучения модели** районный
срез не используется — слишком разрежённый.

#### 4.2. Агрегируем до уровня модели — (регион × ICD × месяц)
Группируем по `(region, icdid, year_month)`, суммируя `recipe_count`,
`total_packs`, `n_clinics`. Дополнительно считаем `n_districts` —
сколько разных районов выписали этот диагноз в этом месяце (этот
сигнал говорит о «географическом охвате»).

#### 4.3. Достраиваем полную сетку месяцев
Это ключевой шаг. Для каждой серии `(регион, ICD)` берём минимальный
и максимальный месяц, в котором эта серия вообще наблюдалась, и
**достраиваем все промежуточные месяцы** через `pd.date_range(freq="MS")`.
Месяцы, в которых рецептов не было, заполняются **нулями** — потому
что «не выписано» это значимый сигнал, а не пропуск данных.

#### 4.4. Выбрасываем короткие серии
Чтобы посчитать `lag_12` (значение год назад) + `roll_mean_12`, нужно
минимум 13 месяцев истории. Серии с **<18 месяцев** удаляются
(`groupby.transform("count") >= 18`). После этого фильтра остаётся
**18 881 серия** — это финальное число.

#### 4.5. Лаги и rolling-статистики
Для каждой серии добавляем:

- **Лаги**: `lag_1`, `lag_2`, `lag_3`, `lag_6`, `lag_12` — значения
  целевой переменной 1, 2, 3, 6, 12 месяцев назад.
- **Rolling mean**: `roll_mean_3`, `roll_mean_6`, `roll_mean_12` —
  скользящее среднее за последние 3 / 6 / 12 месяцев.
- **Rolling std**: `roll_std_3`, `roll_std_6`, `roll_std_12` —
  стандартное отклонение в том же окне (мера волатильности).
- **Expanding mean** — среднее по **всей** истории до текущего
  месяца. Долгосрочный baseline.

Важная деталь: rolling и expanding считаются от **shift(1)** — то
есть от ряда, сдвинутого назад на 1 месяц. Это нужно чтобы не
«подсматривать» текущее значение при расчёте признака для текущего
месяца. Без этого — **target leakage** (утечка целевой переменной).

#### 4.6. Региональный сигнал
Считаем суммарное число рецептов в регионе за каждый месяц, сдвигаем
на 1 месяц назад → `region_total_lag1`. Идея: если в регионе **в
целом** растёт спрос, отдельные диагнозы тоже подрастают.

#### 4.7. Календарные признаки
- `month` (1..12), `quarter` (1..4), `year`;
- `month_idx` — глобальный счётчик месяцев от начала наблюдений (для
  улавливания тренда);
- `month_sin`, `month_cos` — синус/косинус месяца, чтобы декабрь и
  январь были «соседями» в признаковом пространстве (а не на разных
  концах шкалы).

#### 4.8. Глава МКБ
Из кода диагноза берётся первая буква — это глава МКБ. Например
`J20.9` → `J` (болезни органов дыхания). Сохраняется как `icd_chapter`.

#### 4.9. Сохранение
Финальная таблица — `feature_panel.parquet` (~27 МБ, **840 694
строки**). Также сохраняется `series_meta.parquet` со сводной
статистикой по каждой серии (для API: топ-N диагнозов, последнее
значение и т.д.).

### English
This is the most “alchemical” step. From the monthly panel we build a
table where every row already carries **all features** the model needs
at inference time, with nothing left to recompute.

#### 4.1. Stash the district slice for the dashboard
The script first re-saves the whole panel as `district_panel.parquet`.
DuckDB serves this file directly for the UI (map, district filters,
aggregations). The model itself does **not** use the district level —
too sparse.

#### 4.2. Aggregate to the model grain — (region × ICD × month)
Group by `(region, icdid, year_month)`, summing `recipe_count`,
`total_packs`, `n_clinics`. Also compute `n_districts` = number of
districts in which this diagnosis was prescribed that month
(geographic-coverage signal).

#### 4.3. Materialise the complete monthly grid
The key step. For each `(region, ICD)` series take the min and max
observed month and **fill in all months in between** via
`pd.date_range(freq="MS")`. Months with no prescriptions are filled
with **zeros** — “not prescribed” is a meaningful signal, not a
missing-data gap.

#### 4.4. Drop short series
To compute `lag_12` (a year ago) + `roll_mean_12` you need at least
13 months of history. Series with **<18 months** are dropped via
`groupby.transform("count") >= 18`. After this filter **18 881
series** remain — this is the canonical figure.

#### 4.5. Lags and rolling statistics
For each series we add:

- **Lags**: `lag_1`, `lag_2`, `lag_3`, `lag_6`, `lag_12` — the target
  value 1, 2, 3, 6, 12 months ago.
- **Rolling mean**: `roll_mean_3`, `roll_mean_6`, `roll_mean_12` —
  moving average over the last 3 / 6 / 12 months.
- **Rolling std**: `roll_std_3`, `roll_std_6`, `roll_std_12` —
  standard deviation in the same window (a volatility proxy).
- **Expanding mean** — average over the **entire** history up to the
  current month. A long-term baseline.

Important detail: rolling and expanding statistics are computed on
**shift(1)** of the target — the series shifted back by one month.
This is so the row for month *t* never “peeks at” its own value when
computing its features. Without this you get **target leakage**.

#### 4.6. Region-wide signal
Sum prescriptions across the region per month and shift one step back
→ `region_total_lag1`. Intuition: when the **whole region** is up last
month, individual diagnoses tend to follow.

#### 4.7. Calendar features
- `month` (1..12), `quarter` (1..4), `year`;
- `month_idx` — a global month counter from the start of observation
  (captures trend);
- `month_sin`, `month_cos` — sine/cosine of month, so December and
  January are **neighbours** in feature space (instead of opposite
  ends of a 1..12 axis).

#### 4.8. ICD chapter
The first letter of the ICD code. E.g. `J20.9` → `J` (respiratory
diseases). Stored as `icd_chapter`.

#### 4.9. Save
The final table is `feature_panel.parquet` (~27 MB, **840 694 rows**).
A second file, `series_meta.parquet`, holds per-series summary stats
for the API (top-N diagnoses, last value, totals).

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Feature** (признак) | Колонка-входная переменная для модели. У нас 23 признака — 20 числовых + 3 категориальных. |
| **Target** (целевая переменная) | Колонка, которую модель предсказывает. У нас — `recipe_count`. На обучении она же используется и как источник лагов. |
| **Lag** | Значение целевой переменной N месяцев назад. `lag_12 = y[t-12]`. Для прогноза марта 2025 lag_12 = март 2024. |
| **Rolling window** (скользящее окно) | Окно последних N месяцев. По окну считают агрегаты (среднее, std, max…). Если окно «3», то для месяца t используются месяцы t-3, t-2, t-1. |
| **Expanding mean** | Среднее по **всей доступной** истории до текущего момента (окно растёт со временем). |
| **Shift** | Сдвиг ряда по времени: `shift(1)` = «значение прошлого месяца на месте текущего». Используется чтобы признаки не «знали будущее». |
| **Target leakage** (утечка цели) | Самая частая и коварная ошибка ML: в признаки случайно попало значение, которое в проде ещё неизвестно (например текущий `recipe_count` в `roll_mean_3` без shift). На валидации даёт идеальные метрики, в проде — катастрофу. |
| **Categorical feature** | Признак из конечного множества значений (регион, ICD-код, глава МКБ). LightGBM умеет работать с ними нативно через `categorical_feature` — без one-hot. |
| **One-hot encoding** | Способ кодировать категории: вместо одной колонки `region` создаётся N колонок-флагов (`region_atyrau=1`, `region_almaty=0`, …). Раздувает матрицу, лагает LightGBM, поэтому НЕ используется. |
| **Label encoding** | Альтернатива one-hot: каждой категории присваивается целое число (`atyrau=0`, `almaty=1`, …). Дёшево, но порядок чисел не значит «больше/меньше» — модель деревьев это терпит, линейная — нет. У нас используется именно эта схема (`_enc` суффикс). |
| **Sin/cos encoding of cyclic features** | Кодировка циклических признаков (месяц 1..12, час 0..23) через `sin(2πx/период)` и `cos(2πx/период)`. Делает декабрь(12) ↔ январь(1) близкими в пространстве. |
| **Trend** (тренд) | Долгосрочное направление ряда. `month_idx` помогает модели уловить тренд («каждый год выписывается на N% больше»). |
| **MS frequency** | Pandas-код частоты «Month-Start» — первое число каждого месяца. `pd.date_range(freq="MS")` строит сетку первых чисел. |

---

## 5. The final dataset / Финальный датасет

### Русский
В итоге модель видит таблицу `feature_panel.parquet` с **840 694
строками** и **24 колонками** (1 целевая + 23 признака). Каждая
строка — это «один месяц одной серии», и **каждая строка
самодостаточна** — модель не должна ничего пересчитывать на лету,
все лаги и rolling-агрегаты уже посчитаны.

**Схема таблицы**:

```
region              category   # "Атырауская область"          ← категориальный признак (через label encoding → region_enc)
icdid               category   # "J20.9"                        ← категориальный (→ icdid_enc)
icd_chapter         category   # "J"                            ← категориальный (→ icd_chapter_enc)
year_month          datetime   # 2024-03-01                     ← не передаётся модели, нужно для split'а
recipe_count        int64      # 127                            ← TARGET
n_clinics           int64      # 3
n_districts         int64      # 1
lag_1, lag_2, lag_3, lag_6, lag_12               float64
roll_mean_3, roll_mean_6, roll_mean_12           float64
roll_std_3,  roll_std_6,  roll_std_12            float64
expanding_mean                                    float64
region_total_lag1                                 float64
month, quarter, year, month_idx                  int64
month_sin, month_cos                             float64
```

**Train/test split** (внутри `train.py`, не в feature pipeline): для
каждой серии берётся **последние 6 месяцев в test**, всё остальное в
train. Получается:

| Набор | Строк |
| --- | --- |
| Train | **727 408** |
| Test (per-series hold-out) | **113 286** |
| **Всего** | **840 694** |

Почему не один глобальный «cut-off по дате»? Потому что серии
заканчиваются в разное время (Атырау до 2024 Q3, Абай до 2025 Q2). С
глобальным cut-off мы бы тестировались только на регионах с самым
свежим покрытием, и валидация была бы смещённой.

### English
The model sees `feature_panel.parquet` with **840 694 rows** and **24
columns** (1 target + 23 features). Each row is “one month of one
series”, and **every row is self-contained** — the model does not
recompute anything at inference time.

**Schema**:

```
region              category   # "Atyrau Region"               ← categorical (label-encoded → region_enc)
icdid               category   # "J20.9"                        ← categorical (→ icdid_enc)
icd_chapter         category   # "J"                            ← categorical (→ icd_chapter_enc)
year_month          datetime   # 2024-03-01                     ← not fed to the model, used for split
recipe_count        int64      # 127                            ← TARGET
n_clinics           int64      # 3
n_districts         int64      # 1
lag_1, lag_2, lag_3, lag_6, lag_12               float64
roll_mean_3, roll_mean_6, roll_mean_12           float64
roll_std_3,  roll_std_6,  roll_std_12            float64
expanding_mean                                    float64
region_total_lag1                                 float64
month, quarter, year, month_idx                  int64
month_sin, month_cos                             float64
```

**Train/test split** (inside `train.py`, not in the feature pipeline):
the **last 6 months of every series** go to test, everything else to
train. That yields:

| Split | Rows |
| --- | --- |
| Train | **727 408** |
| Test (per-series hold-out) | **113 286** |
| **Total** | **840 694** |

Why not a single global date cut-off? Because different series end at
different dates (Atyrau through 2024 Q3, Abay through 2025 Q2). A
global cut-off would test only on the regions with the freshest
coverage and bias the evaluation.

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Train set / Test set** | Train — данные на которых модель учится. Test (он же hold-out) — данные, *спрятанные* от модели до самого конца, нужны чтобы честно измерить метрику на «свежих» данных. |
| **Hold-out** | То же что test — данные, которые модель не видела при обучении. |
| **Per-series hold-out** | Hold-out по каждой серии отдельно: у каждой `(регион, ICD)` берётся свой «хвост». В отличие от глобального cut-off — устойчивее к разной длине серий. |
| **Cross-validation** | Альтернативный подход: серии много раз делятся на train/test для усреднения. Для временных рядов превращается в *time-series CV* (рекурсивное расширение тренировочного окна). В этом проекте используется простой single-split per-series hold-out — этого достаточно при 840k строк. |
| **Cut-off** | Граничная дата, до которой данные = train, после которой = test. |
| **Self-contained row** | Строка таблицы, содержащая все нужные модели значения без обращения к другим строкам. После feature engineering все наши строки именно такие. |

---

## 6. What lives where on disk / Где что лежит на диске

### Русский

```
Final-Project/
├── datasets/                                   # сырые xlsx, ~12 ГБ (в .gitignore)
│   ├── Атырауская область/*.xlsx
│   └── ...
└── ml/
    ├── prepare_data.py                         # шаг 1 + 2 + 3
    ├── build_features.py                       # шаг 4
    └── data/
        ├── monthly_panel.parquet     ~9 МБ     # выход шага 3 (низший уровень: регион × район × ICD × месяц)
        ├── district_panel.parquet    ~9 МБ     # копия monthly_panel для дашборда (DuckDB читает напрямую)
        ├── feature_panel.parquet    ~27 МБ     # ⭐ выход шага 4 — это то, что ест модель
        └── series_meta.parquet     ~240 КБ     # сводная статистика серий для API
```

Между запусками файлы кэшируются: если поменялся только feature
engineering, `prepare_data.py` запускать заново не нужно — это даёт
огромный выигрыш по времени.

### English

```
Final-Project/
├── datasets/                                   # raw xlsx, ~12 GB (gitignored)
│   ├── Atyrau Region/*.xlsx
│   └── ...
└── ml/
    ├── prepare_data.py                         # steps 1 + 2 + 3
    ├── build_features.py                       # step 4
    └── data/
        ├── monthly_panel.parquet     ~9 MB     # step-3 output (lowest grain: region × district × ICD × month)
        ├── district_panel.parquet    ~9 MB     # copy of monthly_panel for the dashboard (DuckDB reads directly)
        ├── feature_panel.parquet    ~27 MB     # ⭐ step-4 output — what the model consumes
        └── series_meta.parquet     ~240 KB     # per-series summary for the API
```

Artefacts are cached between runs: if only the feature engineering
changed, you do **not** need to re-run `prepare_data.py` — a huge
time-saver.

### Терминология / Terms

| Термин | Определение |
| --- | --- |
| **Artifact** (артефакт) | Любой файл, который пайплайн порождает и оставляет на диске для следующего шага или для проды (`*.parquet`, обученная модель, метаданные). |
| **Caching** | Сохранение результата дорогого шага, чтобы не пересчитывать заново при следующем запуске, если входы не менялись. |
| **`.gitignore`** | Список путей, которые git **не** добавляет в репозиторий. У нас туда занесён `datasets/` (12 ГБ — не место в git). |
| **DuckDB** | Аналитическая СУБД, которая умеет читать parquet напрямую без загрузки в память (zero-copy). Backend использует её для аналитических запросов из дашборда — поэтому `district_panel.parquet` нужен отдельно от модели. |

---

## 7. End-to-end: одна команда / one command

### Русский

```bash
# Полный пайплайн с нуля (часовое чудовище из-за 12 ГБ xlsx)
python ml/prepare_data.py        # ~30–60 мин
python ml/build_features.py      # <1 мин
python ml/train.py               # ~25 сек
```

После этих трёх команд:
1. `ml/data/feature_panel.parquet` — готов для повторного обучения.
2. `ml/models/lgbm_recipe_forecast.txt` — обученный бустер.
3. `ml/models/metadata.json` — метрики на hold-out, список фичей,
   энкодеры категорий — всё что нужно бекенду для предсказаний.

### English

```bash
# Full pipeline from scratch (an hour-long beast because of 12 GB of xlsx)
python ml/prepare_data.py        # ~30–60 min
python ml/build_features.py      # <1 min
python ml/train.py               # ~25 sec
```

After these three commands:
1. `ml/data/feature_panel.parquet` — ready for retraining.
2. `ml/models/lgbm_recipe_forecast.txt` — the trained booster.
3. `ml/models/metadata.json` — hold-out metrics, feature list, category
   encoders — everything the backend needs at inference time.

---

## 8. Summary cheat-sheet / Шпаргалка

| Что | RU | EN |
| --- | --- | --- |
| Источник | 504 xlsx, ~12 ГБ, портал `ashyq.data.gov.kz` | 504 xlsx, ~12 GB, `ashyq.data.gov.kz` |
| Шаг 1 — Чтение | calamine → pandas, 7 нужных колонок | calamine → pandas, 7 needed columns |
| Шаг 2 — Очистка | drop NA on (date, ICD, region); strip; coerce | drop NA on (date, ICD, region); strip; coerce |
| Шаг 3 — Агрегация | (region, district, ICD, year_month) → recipe_count | (region, district, ICD, year_month) → recipe_count |
| Шаг 4 — Сетка | дополнить пропущенные месяцы нулями | fill missing months with zeros |
| Шаг 5 — Фильтр | серии < 18 месяцев — выбросить | drop series with <18 months |
| Шаг 6 — Признаки | лаги, rolling, expanding, calendar, region, chapter | lags, rolling, expanding, calendar, region, chapter |
| Шаг 7 — Сплит | last 6 months per series → test | last 6 months per series → test |
| Итог | 840 694 строки, 18 881 серия, 23 признака | 840 694 rows, 18 881 series, 23 features |

---

**Источники цифр** (не подделаны):
- Размеры файлов: `ml/data/*.parquet` на диске после запуска пайплайна.
- 18 881 серия, 727 408 / 113 286 строк train/test: `ml/models/metadata.json`.
- 23 признака: длина `feature_columns` в том же `metadata.json`.
- Покрытие 2018–2025: `last_observed_month` в metadata + `date_range` в логе `prepare_data.py`.

**Sources of the numbers** (not fabricated):
- File sizes: `ml/data/*.parquet` on disk after running the pipeline.
- 18 881 series, 727 408 / 113 286 train/test rows: `ml/models/metadata.json`.
- 23 features: length of `feature_columns` in the same `metadata.json`.
- 2018–2025 coverage: `last_observed_month` in metadata + `date_range` in the `prepare_data.py` log.
