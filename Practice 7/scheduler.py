import time

import schedule

from batch_predict import run_batch
from config import SCHEDULE_INTERVAL_MINUTES


def job() -> None:
    try:
        run_batch()
    except Exception as exc:
        print(f"[error] batch failed: {exc}")


def main() -> None:
    print(f"scheduler started: every {SCHEDULE_INTERVAL_MINUTES} min")
    job()
    schedule.every(SCHEDULE_INTERVAL_MINUTES).minutes.do(job)

    while True:
        schedule.run_pending()
        time.sleep(1)


if __name__ == "__main__":
    main()
